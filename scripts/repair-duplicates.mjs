#!/usr/bin/env node
/**
 * 修复「同一个会话被两个工作区同时记账」的损坏记录。
 *
 * 背景：0.1.0 的跨区移动在改 header 之后用 `workspace.sessionIds` 判断要不要从源工作区
 * detach —— 那个 getter 按 cwd 过滤，源工作区已经“看不见”它，于是 detach 被跳过，
 * 记录里留下重复。DSH 启动时会把「一个会话被两个工作区记账」判为损坏并拒绝启动，
 * 所以必须在下一次启动前修掉。
 *
 * 归属判定：读会话日志的 header.cwd，realpath 后等于哪个工作区的 path，就保留哪个。
 *
 * 用法：
 *   node scripts/repair-duplicates.mjs            # 只看计划（dry-run）
 *   node scripts/repair-duplicates.mjs --apply    # 备份后写回
 *   node scripts/repair-duplicates.mjs --apply --home /path/to/.dsh
 */
import { copyFile, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { projectKey } from '../src/host/paths.js'

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const apply = process.argv.includes('--apply')
const home = flag('home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const stateFile = join(home, 'storages', 'workspace.json')
const sessionsRoot = join(home, 'sessions')

/**
 * 找出被多个工作区同时记账的会话。
 * @returns {Map<string, string[]>} sessionId → workspaceId[]
 */
export function findDuplicates(state) {
  const owners = new Map()
  for (const [workspaceId, record] of Object.entries(state?.tables?.workspaces ?? {})) {
    for (const sessionId of record.sessionIds ?? []) {
      const bucket = owners.get(sessionId)
      if (bucket === undefined) owners.set(sessionId, [workspaceId])
      else bucket.push(workspaceId)
    }
  }
  return new Map([...owners].filter(([, workspaces]) => workspaces.length > 1))
}

/**
 * 计算修复计划：每个重复会话保留 ownerBySession 指出的那个工作区。
 * @param {object} state 注册表状态
 * @param {Map<string, string>} ownerBySession 会话 → 正确工作区 id
 * @returns {{repairs: Array<{sessionId: string, keep: string, remove: string[]}>, unresolved: string[]}}
 */
export function planRepair(state, ownerBySession) {
  const repairs = []
  const unresolved = []
  for (const [sessionId, workspaceIds] of findDuplicates(state)) {
    const keep = ownerBySession.get(sessionId)
    if (keep === undefined || !workspaceIds.includes(keep)) {
      unresolved.push(sessionId)
      continue
    }
    repairs.push({ sessionId, keep, remove: workspaceIds.filter((id) => id !== keep) })
  }
  return { repairs, unresolved }
}

/** 读一个会话日志的 header（扫所有项目目录找 id）。 */
async function headerOf(sessionId) {
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith('_')) continue
    const dir = join(sessionsRoot, project.name, sessionId)
    let files
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    const log = files.find((name) => name.endsWith('.jsonl.zstd')) ?? files.find((name) => name.endsWith('.jsonl'))
    if (log === undefined) continue
    try {
      const buffer = await readFile(join(dir, log))
      const plain = log.endsWith('.zstd') ? zstdDecompressSync(buffer).toString('utf8') : buffer.toString('utf8')
      return JSON.parse(plain.split('\n')[0])
    } catch {
      continue
    }
  }
  return undefined
}

/** 把 header.cwd 映射到工作区 id。 */
async function ownerOf(sessionId, workspaces) {
  const header = await headerOf(sessionId)
  if (header === undefined || typeof header.cwd !== 'string') return undefined
  let canonical
  try {
    canonical = await realpath(header.cwd)
  } catch {
    canonical = header.cwd
  }
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    let recordPath
    try {
      recordPath = await realpath(record.path)
    } catch {
      recordPath = record.path
    }
    if (recordPath === canonical) return workspaceId
  }
  return undefined
}

async function main() {
const state = JSON.parse(await readFile(stateFile, 'utf8'))
const workspaces = state.tables?.workspaces ?? {}
const ownerBySession = new Map()
for (const sessionId of findDuplicates(state).keys()) {
  const owner = await ownerOf(sessionId, workspaces)
  if (owner !== undefined) ownerBySession.set(sessionId, owner)
}
const { repairs, unresolved } = planRepair(state, ownerBySession)

if (repairs.length === 0 && unresolved.length === 0) {
  console.log('没有重复记账，无需修复。')
  process.exit(0)
}
for (const repair of repairs) {
  console.log(`FIX  ${repair.sessionId}  保留 ${repair.keep}，从 ${repair.remove.join(', ')} 摘除`)
}
for (const sessionId of unresolved) {
  console.log(`SKIP ${sessionId}  找不到归属工作区（日志缺失或 cwd 不匹配），需人工判断`)
}
if (unresolved.length > 0) {
  console.error('\n有无法自动判定的会话，未写回。先确认它们的日志位置。')
  process.exit(1)
}
if (!apply) {
  console.log('\n这是 dry-run。确认无误后加 --apply 写回（会先备份 workspace.json）。')
  process.exit(0)
}

const backup = `${stateFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
await copyFile(stateFile, backup)
for (const repair of repairs) {
  for (const workspaceId of repair.remove) {
    const record = workspaces[workspaceId]
    record.sessionIds = record.sessionIds.filter((id) => id !== repair.sessionId)
  }
}
await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n')
const after = JSON.parse(await readFile(stateFile, 'utf8'))
console.log(`\n已写回：${backup} 是备份；剩余重复 ${findDuplicates(after).size} 个。`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
