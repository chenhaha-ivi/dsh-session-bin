/**
 * 会话跨工作区移动（事务）。
 *
 * 为什么不能直接 rename 目录：会话目录名由 header 里的 cwd 推导，cwd 变了目录必须
 * 跟着变，否则 DSH 的 `assertStoredIdentity` 会把日志判成 corrupt。而 zstd 的已提交
 * 事件帧**不允许改写**，所以不能就地改 header —— 只能「用后继 artifact 重建」：
 *
 *   1. 停活，确认没有写句柄；
 *   2. 读源日志的 header + 全部已提交事件；
 *   3. 把源目录 rename 到 `<sessionsRoot>/_session-bin-staging/<opId>/`（比正式目录
 *      深一层，后端扫描器看不见），保证同一 id 不会同时出现在两个项目目录里；
 *   4. `sessionPersistence.create({...header, cwd: target})` + `append(events)` + `flush()`；
 *   5. 读回校验：事件条数、末条 seq、header.cwd；通过才删暂存区里的源目录；
 *   6. 刷新注册表 header 索引 → attach 到目标工作区 → 从源工作区 detach；
 *   7. 删投影缓存、清暂存区与日志。
 *
 * 每个阶段的崩溃都能收敛：暂存区带一份 journal（fromCwd/toCwd/sessionId），启动时
 * `recoverMoves()` 看「目标 artifact 是否已可用」决定补完还是回滚，**绝不自动删源字节**
 * 除非目标已通过读回校验。
 *
 * @module dsh-session-bin/move
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { BinError, SESSION_ID_PATTERN } from './trash.js'
import { encodeSegment, projectKey } from './paths.js'

/** 暂存区目录名（会话存储根下，深一层让后端看不见）。 */
export const STAGING_DIR_NAME = '_session-bin-staging'
/** 旧版本用过的暂存区目录名；升级后第一次启动时并进新目录。 */
export const LEGACY_STAGING_DIR_NAMES = ['_workspace-bin-staging']
/** 暂存区 journal 版本。 */
const JOURNAL_VERSION = 1
/**
 * 一次移动最多读进内存的日志大小。
 *
 * 现在的实现是「整段读 → 整段 append」，日志越大内存峰值越高。超过这个阈值就
 * 明确拒绝（而不是把进程拖死）；将来要做分片再放开。
 */
const MAX_INLINE_BYTES = 256 * 1024 * 1024

/**
 * 建跨区移动事务对象。
 *
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（取 `sessionPersistence` 与投影缓存）。
 * @param {any} deps.registry `workspaceRegistry` 服务。
 * @param {ReturnType<import('./runtime.js').createRuntime>} deps.runtime
 * @param {() => number} [deps.now]
 */
export function createMoveOps(deps) {
  const { ctx, registry, runtime } = deps
  const { reason, isRunning, quiesce, requireSessionsRoot, pathKind, log } = runtime
  const now = deps.now ?? runtime.now ?? (() => Date.now())
  /** 测试注入的崩溃点（生产不传）。 */
  const hooks = deps.hooks

  /** 会话持久化服务。 */
  function persistence() {
    return ctx?.get?.('sessionPersistence') ?? ctx?.sessionPersistence
  }

  /**
   * 挂在某个会话下的子代理 id。移动只搬被拖的会话，不搬子代理；这里只用于提示，
   * 让用户知道它们留在原工作区，避免以为整棵会话树都跟过去了。
   * @param {string} sessionId
   * @returns {Promise<string[]>}
   */
  async function subagentChildrenOf(sessionId) {
    try {
      const snapshots = await persistence()?.list?.()
      if (!Array.isArray(snapshots)) return []
      return snapshots
        .map((snapshot) => snapshot?.header)
        .filter((header) => header?.parentSession === sessionId && header?.origin === 'subagent')
        .map((header) => header.id)
    } catch {
      return []
    }
  }

  /** 目标 cwd 下的会话目录。 */
  function sessionDirAt(cwd, sessionId) {
    return join(requireSessionsRoot(), projectKey(cwd), encodeSegment(sessionId))
  }

  /** 暂存区根。 */
  function stagingRoot() {
    return join(requireSessionsRoot(), STAGING_DIR_NAME)
  }

  /**
   * 升级兜底：旧版本把暂存区叫 `_workspace-bin-staging`，先整目录改名过来。
   * 不迁的话，崩在一次搬移里的会话会永远停在那儿——恢复逻辑只扫新名字。
   * 新目录已存在时不动旧目录（正常操作下两者不会同时出现）。
   */
  async function adoptLegacyStaging() {
    const target = stagingRoot()
    try {
      await realpath(target)
      return
    } catch {}
    for (const legacyName of LEGACY_STAGING_DIR_NAMES) {
      const legacy = join(dirname(target), legacyName)
      try {
        await realpath(legacy)
      } catch {
        continue
      }
      try {
        await rename(legacy, target)
        log('info', `session-bin: migrated the staging directory ${legacy} -> ${target}`)
      } catch (error) {
        log('warn', `session-bin: could not migrate ${legacy} to ${target}: ${reason(error)}`)
      }
      return
    }
  }

  /** 目标工作区目录必须仍然可用；目录被删/被换成文件时拒绝，别把会话搬进虚空。 */
  async function requireTargetDirectory(path, details) {
    const kind = await pathKind(path)
    if (kind !== 'dir') {
      throw new BinError(
        'session-bin/target-path-missing',
        `the target workspace directory is not usable (${kind}): ${path}`,
        { ...details, targetPath: path, kind },
      )
    }
    return path
  }

  /** 解析目标工作区：显式 id 优先，其次路径（目录必须存在），否则用注册表按路径找/建。 */
  async function resolveTarget(request) {
    if (typeof request.targetWorkspaceId === 'string' && request.targetWorkspaceId.trim() !== '') {
      const workspace = registry.get?.(request.targetWorkspaceId.trim())
      if (workspace === undefined) {
        throw new BinError('session-bin/unknown-target-workspace', `the registry holds no workspace ${JSON.stringify(request.targetWorkspaceId)}`, { targetWorkspaceId: request.targetWorkspaceId })
      }
      await requireTargetDirectory(workspace.path, { targetWorkspaceId: workspace.id })
      return workspace
    }
    if (typeof request.targetPath === 'string' && request.targetPath.trim() !== '') {
      const absolute = resolve(request.targetPath.trim())
      let canonical
      try {
        canonical = await realpath(absolute)
      } catch {
        throw new BinError('session-bin/target-path-missing', `target path does not exist as a directory: ${absolute}`, { targetPath: absolute })
      }
      await requireTargetDirectory(canonical, {})
      const existing = await registry.resolveByPath?.(canonical)
      if (existing !== undefined) return existing
      return await registry.create(canonical)
    }
    throw new BinError('session-bin/invalid-request', 'targetWorkspaceId or targetPath is required')
  }

  /**
   * 把 header 索引指到事实：优先只改这一条会话，避免每次拖拽都全量重扫。
   * 只有私有索引不存在（未来 DSH 移除这些字段）时才退回全量重建。
   */
  async function retargetIndex(sessionId, header, target) {
    if (registry.headers instanceof Map || registry.sessionPaths instanceof Map) {
      if (registry.headers instanceof Map) registry.headers.set(sessionId, header)
      if (registry.sessionPaths instanceof Map) registry.sessionPaths.set(sessionId, target.path)
      if (registry.missingSessionPaths instanceof Set) registry.missingSessionPaths.delete(sessionId)
      if (registry.invalidSessionPaths instanceof Map) registry.invalidSessionPaths.delete(sessionId)
      return false
    }
    let refreshed = false
    try {
      if (typeof registry.listStoredHeaders === 'function' && typeof registry.replaceHeaderIndex === 'function') {
        await registry.replaceHeaderIndex(await registry.listStoredHeaders())
        refreshed = true
      }
    } catch (error) {
      log('warn', `session-bin: refreshing the header index failed: ${reason(error)}`)
    }
    if (registry.headers instanceof Map) registry.headers.set(sessionId, header)
    if (registry.sessionPaths instanceof Map) registry.sessionPaths.set(sessionId, target.path)
    if (registry.missingSessionPaths instanceof Set) registry.missingSessionPaths.delete(sessionId)
    if (registry.invalidSessionPaths instanceof Map) registry.invalidSessionPaths.delete(sessionId)
    return refreshed
  }

  /**
   * 把投影缓存记录的 `identity.cwd` 改到新位置，而不是整条删掉。
   *
   * 缓存身份由 `formatVersion / createdAt / cwd / isSeeded` 组成；跨区移动只改
   * `cwd`，事件一条没变，所以标题/统计这些 row 依然有效。保留它们、只改 cwd，
   * 冷列表（还没打开的会话）才不会显示「未命名」，点开一下才恢复标题。
   */
  async function retargetProjection(sessionId, toCwd) {
    try {
      const table = ctx?.get?.('storageDomain')?.get?.('session_projcache')?.table?.('sessions')
      const record = table?.get?.(sessionId)
      if (record === null || record === undefined || typeof record !== 'object') return false
      if (record.identity === null || typeof record.identity !== 'object') return false
      // 存储域的写接口是 put（不是 set）。
      await table.put?.(sessionId, { ...record, identity: { ...record.identity, cwd: toCwd } })
      return true
    } catch (error) {
      log('warn', `session-bin: retargeting the projection cache failed for ${sessionId}: ${reason(error)}`)
      await invalidateProjection(sessionId)
      return false
    }
  }

  /** 删投影缓存（标题/统计会重建）。 */
  async function invalidateProjection(sessionId) {
    try {
      const table = ctx?.get?.('storageDomain')?.get?.('session_projcache')?.table?.('sessions')
      await table?.delete?.(sessionId)
    } catch (error) {
      log('warn', `session-bin: projection cache cleanup failed for ${sessionId}: ${reason(error)}`)
    }
  }

  /** 把一个刚建好的会话目录搬回源 cwd（回滚用）。 */
  async function restoreParked(parked, sourceDir) {
    await mkdir(dirname(sourceDir), { recursive: true })
    await rename(parked, sourceDir)
  }

  /** 删掉没验证通过的后继目录（只删目标 cwd 下那一个会话目录）。 */
  async function dropSuccessor(sessionId, toCwd) {
    try {
      await rm(sessionDirAt(toCwd, sessionId), { recursive: true, force: true, maxRetries: 2 })
    } catch (error) {
      log('warn', `session-bin: dropping an unverified successor failed: ${reason(error)}`)
    }
  }

  /** 写 journal（原子：临时文件 + rename）。 */
  async function writeJournal(opId, journal) {
    const file = join(stagingRoot(), opId, 'journal.json')
    const temporary = `${file}.tmp-${randomBytes(4).toString('hex')}`
    await writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', 'utf8')
    await rename(temporary, file)
  }

  /** 清暂存区的一个 op。 */
  async function dropOp(opId) {
    await rm(join(stagingRoot(), opId), { recursive: true, force: true, maxRetries: 2 })
  }

  /**
   * 读回校验：目标 artifact 的事件条数、末条 seq、cwd 与源一致。
   * @returns {Promise<{ok: boolean, header?: object, events?: number, lastSeq?: number, why?: string}>}
   */
  async function verifySuccessor(sessionId, expected) {
    const service = persistence()
    let handle
    try {
      handle = await service.open(sessionId, 'read')
      const read = await handle.read()
      const header = handle.header
      const events = Array.isArray(read?.events) ? read.events : []
      const lastSeq = events.length === 0 ? -1 : events[events.length - 1].seq
      if (events.length !== expected.events) return { ok: false, why: `event count ${events.length} != ${expected.events}` }
      if (lastSeq !== expected.lastSeq) return { ok: false, why: `last seq ${lastSeq} != ${expected.lastSeq}` }
      if (header?.cwd !== expected.toCwd) return { ok: false, why: `header cwd ${JSON.stringify(header?.cwd)} != ${JSON.stringify(expected.toCwd)}` }
      return { ok: true, header, events: events.length, lastSeq }
    } catch (error) {
      return { ok: false, why: `cannot read the successor: ${reason(error)}` }
    } finally {
      await handle?.close?.().catch(() => {})
    }
  }

  /**
   * 把一个会话搬到目标工作区。
   *
   * @param {{sessionId: string, targetWorkspaceId?: string, targetPath?: string, callerSessionId?: string}} request
   */
  async function relocateSession(request) {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
    if (sessionId === '') throw new BinError('session-bin/invalid-request', 'sessionId is required')
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new BinError('session-bin/invalid-request', `sessionId is not a plain session id: ${JSON.stringify(sessionId)}`, { sessionId })
    }
    if (typeof request.callerSessionId === 'string' && request.callerSessionId === sessionId) {
      throw new BinError('session-bin/caller-session', 'refusing to move the session this operation is running in', { sessionId })
    }
    const wasRunning = isRunning(sessionId)
    const service = persistence()
    if (service === undefined) {
      throw new BinError('session-bin/no-persistence', 'the session persistence service is unavailable')
    }

    let header
    try {
      header = await registry.readSessionHeader?.(sessionId)
    } catch {
      header = undefined
    }
    if (header === undefined) {
      throw new BinError('session-bin/unknown-session', `session persistence holds no session ${JSON.stringify(sessionId)}`, { sessionId })
    }
    const fromCwd = typeof header.cwd === 'string' ? header.cwd : undefined
    if (fromCwd === undefined) {
      throw new BinError('session-bin/session-without-cwd', `session ${sessionId} has no cwd, so it cannot be moved to a workspace`, { sessionId })
    }

    const target = await resolveTarget(request ?? {})
    const toCwd = target.path
    if (resolve(fromCwd) === resolve(toCwd)) {
      // 目录没变：只补归属，不动文件。
      const warnings = []
      const workspace = registry.get?.(target.id)
      if (workspace !== undefined && !workspace.sessionIds.includes(sessionId)) {
        try {
          await workspace.attachSession(sessionId)
        } catch (error) {
          warnings.push(`attach: ${reason(error)}`)
        }
      }
      return { sessionId, applied: 'already-there', fromCwd, toCwd, targetWorkspaceId: target.id, stoppedRunning: false, warnings }
    }

    // 大日志护栏：先看 sizeBytes，再看要不要整段读。
    try {
      const snapshot = await service.stat?.(sessionId)
      const sizeBytes = typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : undefined
      if (sizeBytes !== undefined && sizeBytes > MAX_INLINE_BYTES) {
        throw new BinError(
          'session-bin/session-too-large',
          `session ${sessionId} is ${sizeBytes} bytes, above the ${MAX_INLINE_BYTES}-byte move limit`,
          { sessionId, sizeBytes, limit: MAX_INLINE_BYTES },
        )
      }
    } catch (error) {
      if (error instanceof BinError) throw error
      // stat 不可用（老后端）就不拦，继续走读回校验。
    }

    const quiesced = await quiesce(sessionId)
    if (!quiesced.released) {
      throw new BinError('session-bin/session-busy', `refusing to move while session ${sessionId} is still writing`, { sessionId, errors: quiesced.errors })
    }

    // 读源：header 与全部已提交事件。读句柄不持有写租约，读完立刻关。
    let events = []
    let inherited
    let sourceHeader = header
    let reader
    try {
      reader = await service.open(sessionId, 'read')
      sourceHeader = reader.header ?? header
      const read = await reader.read()
      events = Array.isArray(read?.events) ? read.events : []
      inherited = typeof reader.inheritedEventCount === 'number' ? reader.inheritedEventCount : undefined
    } catch (error) {
      throw new BinError('session-bin/read-failed', `cannot read session ${sessionId}: ${reason(error)}`, { sessionId })
    } finally {
      await reader?.close?.().catch(() => {})
    }
    const lastSeq = events.length === 0 ? -1 : events[events.length - 1].seq

    const sourceDir = sessionDirAt(fromCwd, sessionId)
    await mkdir(stagingRoot(), { recursive: true })
    const opId = `${new Date(now()).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`
    const stagingOp = join(stagingRoot(), opId)
    const parked = join(stagingOp, encodeSegment(sessionId))

    // 1. 先落 journal，再搬目录：崩溃恢复只信这份 journal + 文件系统事实。
    await mkdir(stagingOp, { recursive: true })
    await writeJournal(opId, {
      version: JOURNAL_VERSION,
      opId,
      sessionId,
      fromCwd,
      toCwd,
      createdAt: new Date(now()).toISOString(),
      events: events.length,
      lastSeq,
    })
    try {
      await hooks?.reach?.('before-park', { sessionId, opId })
      await rename(sourceDir, parked)
      await hooks?.reach?.('after-park', { sessionId, opId })
    } catch (error) {
      await dropOp(opId).catch(() => {})
      throw new BinError('session-bin/move-failed', `parking session ${sessionId} failed: ${reason(error)}`, { sessionId })
    }

    // 2. 用后继 artifact 重建到目标 cwd。
    let writer
    try {
      const nextHeader = { ...sourceHeader, cwd: toCwd }
      writer = await service.create(nextHeader, sourceHeader.isSeeded === true && inherited !== undefined ? { inheritedEventCount: inherited } : undefined)
      if (events.length > 0) await writer.append(events)
      await writer.flush()
      await writer.close()
      await hooks?.reach?.('after-flush', { sessionId, opId })
    } catch (error) {
      await writer?.close?.().catch(() => {})
      await dropSuccessor(sessionId, toCwd)
      let rollbackError
      try {
        await restoreParked(parked, sourceDir)
        await dropOp(opId)
      } catch (rollback) {
        rollbackError = reason(rollback)
      }
      throw new BinError('session-bin/move-failed', `creating the successor log failed: ${reason(error)}`, {
        sessionId,
        rollbackError,
        stagedAt: stagingOp,
      })
    } finally {
      await writer?.close?.().catch(() => {})
    }

    // 3. 读回校验；不通过就回滚，源字节一个都不删。
    const verified = await verifySuccessor(sessionId, { events: events.length, lastSeq, toCwd })
    if (verified.ok !== true) {
      await dropSuccessor(sessionId, toCwd)
      let rollbackError
      try {
        await restoreParked(parked, sourceDir)
        await dropOp(opId)
      } catch (rollback) {
        rollbackError = reason(rollback)
      }
      throw new BinError('session-bin/verify-failed', `the successor log did not verify (${verified.why}); the move was rolled back`, {
        sessionId,
        rollbackError,
        stagedAt: stagingOp,
      })
    }

    await hooks?.reach?.('after-verify', { sessionId, opId })
    const warnings = [...quiesced.errors]
    const children = await subagentChildrenOf(sessionId)
    if (children.length > 0) {
      warnings.push(`${children.length} subagent session(s) stay in the original workspace: ${children.join(', ')}`)
    }
    const refreshed = await retargetIndex(sessionId, verified.header ?? { ...sourceHeader, cwd: toCwd }, target)
    let registryApplied = false
    let registryReason
    try {
      const targetEntity = registry.get?.(target.id) ?? target
      if (!targetEntity.sessionIds.includes(sessionId)) await targetEntity.attachSession(sessionId)
      // 关键：不能先看 `workspace.sessionIds` 再决定 detach。那个 getter 按 header 的 cwd
      // 过滤，而 header 刚被改到目标路径 —— 源工作区在 getter 里已经“看不见”这个会话了，
      // 但**持久化记录里还在**，侧栏就会同时显示在两个工作区。detach 本身是幂等的，直接调。
      for (const workspace of registry.list?.() ?? []) {
        if (workspace.id !== target.id) await workspace.detachSession(sessionId)
      }
      registryApplied = true
    } catch (error) {
      registryReason = reason(error)
      warnings.push(`workspace membership: ${registryReason} (restart will reconcile it)`)
      // 文件已就位，归属没写上：留一份 committed 日志，启动恢复会补。
      await mkdir(stagingOp, { recursive: true }).catch(() => {})
      await writeJournal(opId, {
        version: JOURNAL_VERSION,
        opId,
        sessionId,
        fromCwd,
        toCwd,
        createdAt: new Date(now()).toISOString(),
        events: events.length,
        lastSeq,
        phase: 'committed',
      }).catch(() => {})
    }

    await retargetProjection(sessionId, toCwd)
    await hooks?.reach?.('after-registry', { sessionId, opId })
    // 归属与投影都改完才删暂存区：中间崩溃时 journal 还在，启动恢复能补。
    // 归属没写上就**保留**已 committed 的 journal，等重启补齐（源字节仍在暂存区，恢复会删）。
    if (registryApplied) {
      await dropOp(opId).catch((error) => log('warn', `session-bin: dropping staging failed: ${reason(error)}`))
    }
    log('info', `session-bin: session ${sessionId} moved ${fromCwd} -> ${toCwd}`)
    return {
      sessionId,
      applied: 'moved',
      fromCwd,
      toCwd,
      targetWorkspaceId: target.id,
      events: events.length,
      lastSeq,
      refreshed,
      registry: { applied: registryApplied, reason: registryReason },
      stoppedRunning: wasRunning,
      warnings,
    }
  }

  /**
   * 启动恢复：扫暂存区，按「目标 artifact 是否可用」决定补完还是回滚。
   * @returns {Promise<{recovered: Array<{opId: string, sessionId: string, action: string}>, unresolved: string[], errors: string[]}>}
   */
  async function recoverMoves() {
    const recovered = []
    const unresolved = []
    const errors = []
    let children
    try {
      await adoptLegacyStaging()
      children = await readdir(stagingRoot(), { withFileTypes: true })
    } catch {
      return { recovered, unresolved, errors }
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const opId = child.name
      const opDir = join(stagingRoot(), opId)
      let journal
      try {
        journal = JSON.parse(await readFile(join(opDir, 'journal.json'), 'utf8'))
      } catch (error) {
        unresolved.push(opId)
        errors.push(`${opId}: unreadable journal (${reason(error)})`)
        continue
      }
      try {
        const sessionId = journal.sessionId
        const stagedDir = join(opDir, encodeSegment(sessionId))
        const verified = await verifySuccessor(sessionId, {
          events: journal.events ?? 0,
          lastSeq: journal.lastSeq ?? -1,
          toCwd: journal.toCwd,
        })
        if (verified.ok) {
          const target = await registry.resolveByPath?.(journal.toCwd).catch(() => undefined)
          if (target !== undefined) {
            await retargetIndex(sessionId, verified.header, target)
            try {
              if (!target.sessionIds.includes(sessionId)) await target.attachSession(sessionId)
              // 同 relocateSession：按记录清，不按过滤后的 getter 判断。
              for (const workspace of registry.list?.() ?? []) {
                if (workspace.id !== target.id) await workspace.detachSession(sessionId)
              }
            } catch (error) {
              errors.push(`${opId}: workspace membership (${reason(error)})`)
            }
          }
          await retargetProjection(sessionId, journal.toCwd)
          await dropOp(opId)
          recovered.push({ opId, sessionId, action: 'completed' })
          continue
        }
        // 目标不可用：回滚到源目录。
        const stagedKind = await pathKind(stagedDir)
        if (stagedKind !== 'dir') {
          // 崩在「journal 写完、源目录还没 park」之间：源文件仍在原位，
          // 清掉空的暂存 op 即可，不能拿不存在的 stagedDir 去 rename。
          const sourceKind = await pathKind(sessionDirAt(journal.fromCwd, sessionId))
          if (sourceKind !== 'dir') {
            throw new Error('neither the staged source nor the original session directory exists')
          }
          await dropOp(opId)
          recovered.push({ opId, sessionId, action: 'discarded-noop' })
          continue
        }
        await rm(sessionDirAt(journal.toCwd, sessionId), { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
        await mkdir(dirname(sessionDirAt(journal.fromCwd, sessionId)), { recursive: true })
        await restoreParked(stagedDir, sessionDirAt(journal.fromCwd, sessionId))
        await dropOp(opId)
        recovered.push({ opId, sessionId, action: 'rolled-back' })
      } catch (error) {
        unresolved.push(opId)
        errors.push(`${opId}: ${reason(error)}`)
      }
    }
    return { recovered, unresolved, errors }
  }

  return { relocateSession, recoverMoves }
}
