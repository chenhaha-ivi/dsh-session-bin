/**
 * 单会话删除 / 恢复。
 *
 * 一次删除做三件事，顺序和删除工作区一致：
 *   1. 停活并驱逐运行时（写句柄不松开，文件就搬不动）；
 *   2. 写 `planned` manifest，把会话目录 rename 进回收站；
 *   3. 从工作区成员表 / 归档 / 置顶集合里摘掉，`done`。
 *
 * 恢复就是反过来：rename 回原项目目录 → 按 manifest 里的工作区重新 attach →
 * 还原归档/置顶 → 删条目。原工作区没了就只恢复会话（侧栏里显示为未分组）。
 *
 * 会话目录里的 header（含 cwd）跟着目录一起走，所以**不需要重建 header** ——
 * 这也是单会话删除比跨区移动简单的地方（移动要改 cwd，必须用后继 artifact 重建）。
 *
 * @module dsh-session-bin/session
 */

import { mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BinError, MANIFEST_VERSION, SESSION_ID_PATTERN, directorySize } from './trash.js'
import { encodeSegment, projectKey } from './paths.js'

/**
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文。
 * @param {any} deps.registry `workspaceRegistry` 服务。
 * @param {ReturnType<import('./trash.js').createBin>} deps.bin 回收站。
 * @param {ReturnType<import('./runtime.js').createRuntime>} deps.runtime 运行时探针。
 * @param {() => number} [deps.now] 时钟（测试注入）。
 */
export function createSessionOps(deps) {
  const { registry, bin, runtime } = deps
  const { reason, isLive, isRunning, quiesce, titleOf, pathKind, requireSessionsRoot, announceRemoved, log } = runtime
  const now = deps.now ?? runtime.now ?? (() => Date.now())
  /** 测试注入的崩溃点（生产不传）。 */
  const hooks = deps.hooks

  /**
   * 删除确认框里的大小：优先用持久化的物理大小，避免对一个大会话做两次递归扫盘。
   * stat 不可用（后端未物化/老实现）时退回目录统计。
   * @param {string} sessionId
   * @param {string} sessionDir
   * @returns {Promise<number>}
   */
  async function sessionSize(sessionId, sessionDir) {
    try {
      const snapshot = await deps.ctx?.get?.('sessionPersistence')?.stat?.(sessionId)
      if (typeof snapshot?.sizeBytes === 'number' && snapshot.sizeBytes > 0) return snapshot.sizeBytes
    } catch {
      // stat 不是关键路径：失败就退回递归统计。
    }
    return await directorySize(sessionDir)
  }

  /**
   * 从所有工作区的成员表里摘掉一个会话。
   *
   * 不能用 `workspace.sessionIds.includes(...)` 当门禁：那个 getter 会按 header 的 cwd
   * 过滤，等目录/header 动过之后，记录里明明还有、getter 里却已经看不见了。
   * detach 是幂等的，无脑调。
   */
  async function detachEverywhere(sessionId) {
    for (const workspace of registry.list?.() ?? []) {
      await workspace.detachSession(sessionId)
    }
  }

  /** 按 manifest 记的标记还原归档 / 置顶。 */
  async function restoreFlags(manifest, warnings) {
    for (const session of manifest.sessions) {
      if (session.archived === true && typeof registry.archiveSession === 'function') {
        await registry.archiveSession(session.id).catch((error) => warnings.push(`archive ${session.id}: ${reason(error)}`))
      }
      if (session.pinned === true && typeof registry.pinSession === 'function') {
        await registry.pinSession(session.id).catch((error) => warnings.push(`pin ${session.id}: ${reason(error)}`))
      }
    }
  }

  /** 找到一个会话的磁盘目录与归属，不执行任何写操作。 */
  async function surveySession(request) {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId.trim() : ''
    if (sessionId === '') throw new BinError('session-bin/invalid-request', 'sessionId is required')
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new BinError('session-bin/invalid-request', `sessionId is not a plain session id: ${JSON.stringify(sessionId)}`, { sessionId })
    }
    const callerSessionId = typeof request?.callerSessionId === 'string' ? request.callerSessionId : undefined
    if (callerSessionId === sessionId) {
      throw new BinError('session-bin/caller-session', 'refusing to delete the session this operation is running in', { callerSessionId })
    }
    const running = isRunning(sessionId)

    let header
    try {
      header = await registry.readSessionHeader?.(sessionId)
    } catch {
      header = undefined
    }
    if (header === undefined) {
      throw new BinError('session-bin/unknown-session', `session persistence holds no session ${JSON.stringify(sessionId)}`, { sessionId })
    }
    const cwd = typeof header.cwd === 'string' ? header.cwd : undefined
    if (cwd === undefined) {
      throw new BinError('session-bin/session-without-cwd', `session ${sessionId} has no cwd, so its directory cannot be located`, { sessionId })
    }

    const sessionsRoot = requireSessionsRoot()
    const key = projectKey(cwd)
    const projectDir = join(sessionsRoot, key)
    const sessionDir = join(projectDir, encodeSegment(sessionId))
    const directoryKind = await pathKind(sessionDir)
    if (directoryKind !== 'dir') {
      throw new BinError(
        'session-bin/no-session-directory',
        `session ${sessionId} has no directory on disk (${directoryKind})`,
        { sessionId, sessionDir },
      )
    }

    let workspace
    try {
      workspace = await registry.resolveByPath?.(cwd)
    } catch {
      workspace = undefined
    }

    const archived = (registry.archivedSessionIds ?? []).includes(sessionId)
    const pinned = (registry.pinnedSessionIds ?? []).includes(sessionId)
    return {
      kind: 'session',
      session: {
        id: sessionId,
        title: await titleOf(sessionId),
        cwd,
        archived,
        pinned,
        live: isLive(sessionId),
        dir: sessionDir,
      },
      workspace: workspace === undefined
        ? null
        : { id: workspace.id, path: workspace.path, title: workspace.title },
      projectKey: key,
      projectDir,
      sessionDir,
      size: await sessionSize(sessionId, sessionDir),
      sessionCount: 1,
      running,
    }
  }

  /**
   * 执行一次已 survey 的单会话删除。
   * @param {object} plan `surveySession` 的返回值。
   */
  async function executeSession(plan) {
    const session = plan.session
    const warnings = []
    const quiesced = await quiesce(session.id)
    warnings.push(...quiesced.errors)
    if (!quiesced.released) {
      throw new BinError('session-bin/session-busy', `refusing to delete while session ${session.id} is still writing`, { sessionId: session.id })
    }

    const manifest = {
      version: MANIFEST_VERSION,
      kind: 'session',
      createdAt: new Date(now()).toISOString(),
      state: 'planned',
      workspace: plan.workspace === null
        ? null
        : {
            id: plan.workspace.id,
            path: plan.workspace.path,
            title: plan.workspace.title,
          },
      projectKey: plan.projectKey,
      size: plan.size,
      sessions: [{
        id: session.id,
        title: session.title,
        archived: session.archived,
        pinned: session.pinned,
      }],
    }
    const entry = await bin.allocate(manifest)
    await hooks?.reach?.('after-plan', { entryId: entry.id })
    const destination = join(bin.sessionsDir(entry.id), plan.projectKey, encodeSegment(session.id))

    try {
      await mkdir(dirname(destination), { recursive: true })
      await rename(plan.sessionDir, destination)
    } catch (error) {
      await bin.removeEntry(entry.id).catch(() => {})
      throw new BinError('session-bin/move-failed', `moving session ${session.id} into the recycle bin failed: ${reason(error)}`, { entryId: entry.id })
    }

    await hooks?.reach?.('after-move', { entryId: entry.id })
    try {
      await detachEverywhere(session.id)
      if (session.archived) await registry.unarchiveSession?.(session.id).catch((error) => warnings.push(`unarchive: ${reason(error)}`))
      if (session.pinned) await registry.unpinSession?.(session.id).catch((error) => warnings.push(`unpin: ${reason(error)}`))
    } catch (error) {
      // 回滚：目录搬回去，归属与标记补回来。
      let rollbackError
      try {
        await mkdir(dirname(plan.sessionDir), { recursive: true })
        await rename(destination, plan.sessionDir)
      } catch (rollbackFailure) {
        rollbackError = reason(rollbackFailure)
      }
      if (rollbackError === undefined) {
        try {
          if (plan.workspace !== null) {
            const workspace = registry.get?.(plan.workspace.id) ?? await registry.resolveByPath?.(plan.workspace.path)
            await workspace?.attachSession?.(session.id)
            await restoreFlags(manifest, warnings)
          }
          await bin.removeEntry(entry.id).catch(() => {})
        } catch (restoreFailure) {
          rollbackError = reason(restoreFailure)
        }
      }
      if (rollbackError !== undefined) {
        await bin.transition(entry.id, 'failed', { error: reason(error), rollbackError }).catch(() => {})
      }
      throw new BinError('session-bin/delete-failed', `removing session ${session.id} from its workspace failed: ${reason(error)}`, {
        entryId: entry.id,
        rollbackError,
      })
    }

    await hooks?.reach?.('after-registry', { entryId: entry.id })
    const finished = await bin.transition(entry.id, 'done', { finishedAt: new Date(now()).toISOString() })
    for (const moved of finished.sessions) announceRemoved(moved.id)
    log('info', `session-bin: session ${session.id} moved to entry ${entry.id}`)
    return {
      entryId: entry.id,
      mode: 'session',
      moved: 1,
      skipped: [],
      sessionCount: 1,
      warnings,
      manifest: finished,
    }
  }

  /**
   * 恢复一个 `kind: session` 条目（由 workspace 的 restore 分发进来）。
   * @param {object} manifest 已校验的 manifest。
   * @param {string} entryId 条目 id。
   */
  async function restoreSession(manifest, entryId) {
    if (manifest.state !== 'done') {
      throw new BinError(
        'session-bin/not-done',
        `entry ${entryId} is ${manifest.state}; only a completed delete can be restored`,
        { entryId, state: manifest.state },
      )
    }
    const sessionsRoot = requireSessionsRoot()
    const warnings = []
    const restored = []
    for (const session of manifest.sessions) {
      const encoded = encodeSegment(session.id)
      const from = join(bin.sessionsDir(entryId), manifest.projectKey, encoded)
      const to = join(sessionsRoot, manifest.projectKey, encoded)
      const fromKind = await pathKind(from)
      if (fromKind !== 'dir') {
        if ((await pathKind(to)) === 'dir') {
          // 上一次恢复在「目录已回位、还没 attach」时崩了：文件已经在目标位置，
          // 仍要把它算作 restored，否则下面的 attach 循环会跳过它，会话变成未分组。
          restored.push(session.id)
          continue
        }
        warnings.push(`session ${session.id} has no directory in the recycle bin`)
        continue
      }
      if ((await pathKind(to)) === 'dir') {
        throw new BinError(
          'session-bin/restore-conflict',
          `cannot restore session ${session.id}: ${to} already exists`,
          { entryId, sessionId: session.id, path: to },
        )
      }
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
      restored.push(session.id)
    }

    let workspace
    if (manifest.workspace !== null && manifest.workspace !== undefined) {
      workspace = registry.get?.(manifest.workspace.id)
      if (workspace === undefined) {
        try {
          workspace = await registry.resolveByPath?.(manifest.workspace.path)
        } catch {
          workspace = undefined
        }
      }
    }
    const attached = []
    if (workspace === undefined) {
      warnings.push('the original workspace is gone; the session was restored ungrouped')
    } else {
      for (const session of manifest.sessions) {
        if (!restored.includes(session.id) || workspace.sessionIds.includes(session.id)) continue
        try {
          await workspace.attachSession(session.id)
          attached.push(session.id)
        } catch (error) {
          warnings.push(`attach ${session.id}: ${reason(error)}`)
        }
      }
      await restoreFlags(manifest, warnings)
    }

    try {
      await bin.removeEntry(entryId)
    } catch (error) {
      warnings.push(`remove recycle-bin entry: ${reason(error)}`)
    }
    log('info', `session-bin: restored session entry ${entryId}`)
    return {
      entryId,
      kind: 'session',
      restoredTo: join(sessionsRoot, manifest.projectKey),
      workspaceId: workspace?.id,
      workspaceRestored: workspace !== undefined,
      restored,
      attached,
      warnings,
    }
  }

  return { surveySession, executeSession, restoreSession, detachEverywhere }
}
