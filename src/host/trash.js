/**
 * 回收站存储：目录布局、manifest、状态机、扫描。
 *
 * 布局（与 docs/DEVELOPMENT.md 的「回收站存储」一节一致）：
 *
 *   <DSH_HOME>/session-bin/
 *     <entryId>/
 *       manifest.json                     # 唯一的事实来源，先写后搬
 *       sessions/<projectKey>/<sessionId>/ # 从 sessions 根整目录 / 逐会话搬来
 *
 * 设计要点：
 *   - **目录只是数据，manifest 才是清单**。恢复 / 清空 / 启动恢复都只信 manifest，
 *     并以磁盘实际存在与否决定「回滚」还是「补完」。
 *   - **原子写**：先写同目录临时文件并 fsync，再 rename 覆盖。崩溃时要么是旧 manifest，
 *     要么是新 manifest，不会读到半个 JSON。
 *   - **状态机只允许往前走**：`planned → done | failed`，已终结的状态不再改
 *     （同状态重写是幂等的，供恢复流程补写）。
 *   - 扫描**绝不删除任何东西**：发现坏 manifest 只报告，不清理。
 *
 * @module dsh-session-bin/trash
 */

import { randomBytes } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/** 回收站根目录名（在 DSH home 之下）。 */
export const TRASH_ROOT_NAME = 'session-bin'
/** 旧版本（≤0.4.x）用过的根目录名，只在首次启动时迁移一次。 */
export const LEGACY_TRASH_ROOT_NAMES = ['workspace-bin']
/** 每个条目的清单文件名。 */
export const MANIFEST_NAME = 'manifest.json'
/** manifest 结构版本。 */
export const MANIFEST_VERSION = 1
/** 条目 id：`yyyyMMddTHHmmss-<6hex>`，按字典序即时间序。 */
export const ENTRY_ID_PATTERN = /^[0-9]{8}T[0-9]{6}-[0-9a-f]{6}$/
/** 会话 id 在本插件里是路径段，只接受保守字符。 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/

const KINDS = new Set(['workspace', 'session'])
const STATES = new Set(['planned', 'done', 'failed'])
/** 允许的状态迁移；同状态重写单独放行（幂等）。 */
const TRANSITIONS = new Map([
  ['planned', new Set(['done', 'failed'])],
  ['done', new Set()],
  ['failed', new Set()],
])

/**
 * 回收站操作的稳定错误：调用方（路由层）靠 `code` 出信封，不解析 message。
 */
export class BinError extends Error {
  /**
   * @param {string} code 稳定错误码（`session-bin/...`）。
   * @param {string} message 人话。
   * @param {Record<string, unknown>} [details] 结构化细节。
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BinError'
    this.code = code
    this.details = details
  }
}

/**
 * 生成一个条目 id。
 *
 * 时间戳用 UTC（与 manifest 的 ISO 时间一致），只到秒；同秒碰撞由 6 位随机十六进制
 * 区分，`allocate` 还会在目录已存在时重试。
 *
 * @param {Date} [date] 时间源（测试可注入）。
 * @param {(size: number) => Buffer} [random] 随机源（测试可注入）。
 * @returns {string}
 */
export function entryIdOf(date = new Date(), random = randomBytes) {
  const stamp = date.toISOString().replace(/[-:]/g, '').slice(0, 15)
  return `${stamp}-${random(3).toString('hex')}`
}

/**
 * 校验一份 manifest，返回全部问题（空数组表示合法）。
 *
 * 校验是**结构层**的：不检查磁盘上目录是否存在，那由扫描 / 恢复流程负责。
 *
 * @param {unknown} value 反序列化后的 manifest。
 * @returns {string[]} 问题列表。
 */
export function validateManifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return ['manifest must be a JSON object']
  }
  const problems = []
  if (value.version !== MANIFEST_VERSION) {
    problems.push(`version must be ${MANIFEST_VERSION}, got ${JSON.stringify(value.version)}`)
  }
  if (!KINDS.has(value.kind)) {
    problems.push(`kind must be one of ${[...KINDS].join('/')}, got ${JSON.stringify(value.kind)}`)
  }
  if (!STATES.has(value.state)) {
    problems.push(`state must be one of ${[...STATES].join('/')}, got ${JSON.stringify(value.state)}`)
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    problems.push('createdAt must be an ISO timestamp string')
  }
  if (typeof value.projectKey !== 'string' || value.projectKey.length === 0) {
    problems.push('projectKey must be a non-empty string')
  }
  if (value.size !== undefined && (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0)) {
    problems.push('size must be a non-negative finite number when present')
  }
  if (value.kind === 'workspace' && !isWorkspaceRecord(value.workspace)) {
    problems.push('kind=workspace requires a workspace record {id, path, title, createdAt, updatedAt}')
  }
  if (value.kind === 'session' && value.workspace !== null && value.workspace !== undefined
    && !isWorkspaceRecord(value.workspace)) {
    problems.push('kind=session workspace, when present, must be a workspace record')
  }
  if (!Array.isArray(value.sessions)) {
    problems.push('sessions must be an array')
  } else {
    value.sessions.forEach((session, index) => {
      if (session === null || typeof session !== 'object' || Array.isArray(session)) {
        problems.push(`sessions[${index}] must be an object`)
        return
      }
      if (typeof session.id !== 'string' || !SESSION_ID_PATTERN.test(session.id)) {
        problems.push(`sessions[${index}].id must be a plain session id`)
      }
      if (session.title !== undefined && typeof session.title !== 'string') {
        problems.push(`sessions[${index}].title must be a string when present`)
      }
      for (const flag of ['archived', 'pinned']) {
        if (session[flag] !== undefined && typeof session[flag] !== 'boolean') {
          problems.push(`sessions[${index}].${flag} must be a boolean when present`)
        }
      }
    })
  }
  return problems
}

/**
 * 一条 workspace 记录的结构校验（宽容：只要求恢复需要的字段）。
 * @param {unknown} value
 * @returns {boolean}
 */
function isWorkspaceRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.path === 'string' && value.path.length > 0
    && (value.title === undefined || typeof value.title === 'string')
}

/**
 * 把旧版本的回收站根目录改名成 `TRASH_ROOT_NAME`（一次性、幂等、失败不致命）。
 *
 * 条目 manifest 只记原工作区路径与 `projectKey`，**不记回收站根目录的绝对路径**，
 * 所以整目录 `rename` 不会让恢复失效，也不需要重写条目。
 *
 * 三种情况：
 *   1. 新目录已存在 → 什么都不做（旧目录即使还在也忽略，避免两份清单打架）；
 *   2. 只有旧目录 → 改名；改名失败（跨卷、权限）就**继续用旧目录**，
 *      宁可老数据看不见新名字，也不能让回收站「凭空清空」；
 *   3. 都没有 → 返回新路径，由第一次写入时创建。
 *
 * @param {{ home: string, logger?: {warn?: Function, info?: Function} }} options
 * @returns {{ root: string, migrated: boolean, from?: string }}
 */
export function migrateLegacyRoot(options) {
  const home = options !== null && typeof options === 'object' ? options.home : options
  const logger = options !== null && typeof options === 'object' ? options.logger : undefined
  if (typeof home !== 'string' || home.trim() === '') {
    throw new BinError('session-bin/no-home', 'cannot locate the DSH home, so the recycle bin was not opened')
  }
  const base = resolve(home)
  const root = join(base, TRASH_ROOT_NAME)
  if (existsSync(root)) return { root, migrated: false }

  for (const legacyName of LEGACY_TRASH_ROOT_NAMES) {
    const legacy = join(base, legacyName)
    if (!existsSync(legacy)) continue
    try {
      renameSync(legacy, root)
      logger?.info?.(`session-bin: migrated the recycle bin directory ${legacy} -> ${root}`)
      return { root, migrated: true, from: legacy }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`session-bin: could not migrate ${legacy} to ${root} (${reason}); keep using ${legacy}`)
      return { root: legacy, migrated: false, from: legacy }
    }
  }
  return { root, migrated: false }
}

/**
 * 打开一个回收站。
 *
 * @param {{ home: string, logger?: {warn?: Function, info?: Function} }} options `home` 是 DSH home（相当于 `$DSH_HOME`）。
 * @returns {ReturnType<typeof createBinApi>}
 */
export function createBin(options) {
  const home = options !== null && typeof options === 'object' ? options.home : options
  if (typeof home !== 'string' || home.trim() === '') {
    throw new BinError('session-bin/no-home', 'cannot locate the DSH home, so the recycle bin was not opened')
  }
  const { root } = migrateLegacyRoot({ home, logger: options?.logger })
  return createBinApi(root)
}

/**
 * 以根目录构造回收站 API（`createBin` 的内部形态，测试也可直接用）。
 * @param {string} root 回收站根目录。
 */
function createBinApi(root) {
  /**
   * @param {string} id
   * @returns {string}
   */
  function entryDir(id) {
    if (!ENTRY_ID_PATTERN.test(id)) {
      throw new BinError('session-bin/bad-entry-id', `not a recycle-bin entry id: ${JSON.stringify(id)}`, { id })
    }
    return join(root, id)
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  function sessionsDir(id) {
    return join(entryDir(id), 'sessions')
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  function manifestPath(id) {
    return join(entryDir(id), MANIFEST_NAME)
  }

  /** 确保回收站根存在（空回收站也要有一个目录）。 */
  async function ensure() {
    await mkdir(root, { recursive: true })
  }

  /**
   * 新建一个条目：分配 id、建目录、写 manifest。
   *
   * @param {object} manifest 已校验的 manifest（createdAt 缺省时补当前时间）。
   * @returns {Promise<{id: string, dir: string, manifest: object}>}
   */
  async function allocate(manifest) {
    const problems = validateManifest(manifest)
    if (problems.length > 0) {
      throw new BinError('session-bin/bad-manifest', 'refusing to write an invalid manifest', { problems })
    }
    await ensure()
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = entryIdOf()
      const dir = join(root, id)
      try {
        await mkdir(dir)
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'EEXIST') continue
        throw error
      }
      await mkdir(join(dir, 'sessions'))
      await writeManifest(id, manifest)
      return { id, dir, manifest }
    }
    throw new BinError('session-bin/entry-id-exhausted', 'could not allocate a unique recycle-bin entry id')
  }

  /**
   * 原子写 manifest。
   * @param {string} id 条目 id。
   * @param {object} manifest 完整 manifest。
   */
  async function writeManifest(id, manifest) {
    const problems = validateManifest(manifest)
    if (problems.length > 0) {
      throw new BinError('session-bin/bad-manifest', 'refusing to write an invalid manifest', { id, problems })
    }
    await writeJsonAtomic(manifestPath(id), manifest)
  }

  /**
   * 读 manifest；不存在或损坏都抛 `BinError`。
   * @param {string} id 条目 id。
   * @returns {Promise<object>}
   */
  async function readManifest(id) {
    const path = manifestPath(id)
    let raw
    try {
      raw = await readFileUtf8(path)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        throw new BinError('session-bin/missing-manifest', `recycle-bin entry ${id} has no manifest`, { id })
      }
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BinError('session-bin/bad-manifest', `recycle-bin entry ${id} has a manifest that is not JSON`, { id })
    }
    const problems = validateManifest(parsed)
    if (problems.length > 0) {
      throw new BinError('session-bin/bad-manifest', `recycle-bin entry ${id} has an invalid manifest`, { id, problems })
    }
    return parsed
  }

  /**
   * 状态迁移；同状态重写是幂等的，其余非法迁移拒绝。
   *
   * @param {string} id 条目 id。
   * @param {'planned'|'done'|'failed'} next 目标状态。
   * @param {Record<string, unknown>} [patch] 一并合并进 manifest 的字段。
   * @returns {Promise<object>} 迁移后的 manifest。
   */
  async function transition(id, next, patch = {}) {
    const manifest = await readManifest(id)
    if (!STATES.has(next)) {
      throw new BinError('session-bin/bad-state', `unknown recycle-bin state ${JSON.stringify(next)}`, { id, next })
    }
    if (next !== manifest.state) {
      const allowed = TRANSITIONS.get(manifest.state)
      if (allowed === undefined || !allowed.has(next)) {
        throw new BinError('session-bin/bad-transition', `refusing ${manifest.state} -> ${next} for entry ${id}`, {
          id,
          from: manifest.state,
          to: next,
        })
      }
    }
    const updated = { ...manifest, ...patch, state: next }
    await writeManifest(id, updated)
    return updated
  }

  /**
   * 扫描回收站：合法条目 + 损坏条目分开报告；**不删除任何东西**。
   *
   * 只把符合 `ENTRY_ID_PATTERN` 的目录当条目，其他目录（比如手工放的垃圾）忽略。
   *
   * @returns {Promise<{root: string, entries: Array<{id: string, dir: string, manifest: object}>, broken: Array<{id: string, dir: string, reason: string}>}>}
   */
  async function scan() {
    const entries = []
    const broken = []
    let children
    try {
      children = await readdir(root, { withFileTypes: true })
    } catch {
      return { root, entries, broken }
    }
    for (const child of children) {
      if (!child.isDirectory() || !ENTRY_ID_PATTERN.test(child.name)) continue
      const dir = join(root, child.name)
      try {
        const manifest = await readManifest(child.name)
        entries.push({ id: child.name, dir, manifest })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        broken.push({ id: child.name, dir, reason })
      }
    }
    entries.sort((left, right) => right.id.localeCompare(left.id))
    broken.sort((left, right) => right.id.localeCompare(left.id))
    return { root, entries, broken }
  }

  /**
   * 删除一个条目的全部字节（唯一真正删数据的入口）。
   * @param {string} id 条目 id。
   */
  async function removeEntry(id) {
    await rm(entryDir(id), { recursive: true, force: true, maxRetries: 3 })
  }

  /**
   * 条目占用的字节数（不跟随符号链接；读失败按 0 计）。
   * @param {string} id 条目 id。
   * @returns {Promise<number>}
   */
  async function entrySize(id) {
    return await directorySize(entryDir(id))
  }

  /**
   * 把条目字节数补写进 manifest（老条目没有 size 时懒补）。
   *
   * 递归统计是 O(字节) 的；每次 list 都扫一遍会让大回收站越用越慢，所以统计一次写回。
   * 失败不抛：这只是缓存，下一次 list 还会再试。
   * @param {string} id 条目 id。
   * @param {number} size 已统计出的字节数。
   * @returns {Promise<object | undefined>} 更新后的 manifest（失败/无需更新时为 undefined）。
   */
  async function recordSize(id, size) {
    try {
      const manifest = await readManifest(id)
      // 0 只可能是「源目录统计时为空」，条目本身至少还有 manifest，按未缓存处理。
      if (typeof manifest.size === 'number' && manifest.size > 0) return manifest
      const next = { ...manifest, size }
      if (validateManifest(next).length > 0) return manifest
      await writeManifest(id, next)
      return next
    } catch {
      return undefined
    }
  }

  /** 回收站根目录。 */
  return {
    root,
    entryDir,
    sessionsDir,
    manifestPath,
    ensure,
    allocate,
    readManifest,
    writeManifest,
    transition,
    scan,
    removeEntry,
    entrySize,
    recordSize,
  }
}

/**
 * 递归统计目录字节数。
 * @param {string} path
 * @returns {Promise<number>}
 */
export async function directorySize(path) {
  let total = 0
  let children
  try {
    children = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const child of children) {
    const childPath = join(path, child.name)
    if (child.isDirectory()) {
      total += await directorySize(childPath)
    } else if (child.isFile()) {
      try {
        total += (await stat(childPath)).size
      } catch {
        // 文件刚好被删：不计入。
      }
    }
  }
  return total
}

/**
 * 写 JSON：同目录临时文件 → fsync → rename → fsync 目录（尽力而为）。
 * @param {string} file
 * @param {unknown} value
 */
async function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
  await syncDirectory(dirname(file))
}

/**
 * 目录 fsync（POSIX 上让 rename 落盘；Windows 不支持则忽略）。
 * @param {string} dir
 */
async function syncDirectory(dir) {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch {
    // 平台不支持目录 fsync：rename 本身已足够在绝大多数文件系统上保证可见性。
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 读 UTF-8 文本。
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readFileUtf8(path) {
  return await readFile(path, 'utf8')
}
