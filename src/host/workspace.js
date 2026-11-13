/**
 * 工作区回收站的事务层：删除 / 恢复 / 永久删除。
 *
 * 与 trash.js 的分工：trash.js 只管「回收站目录长什么样、manifest 怎么落盘」，
 * 这里管「一次删除/恢复要按什么顺序动谁」。
 *
 * 删除工作区不是一次 rename 就完事：
 *   1. 先停活、驱逐运行时（不先做这步，Windows 上文件根本搬不动）；
 *   2. 写 `planned` manifest —— 崩溃恢复靠它判断「搬到哪一步了」；
 *   3. 搬文件：项目目录**独占**时整目录 rename（快、原子），否则逐会话 rename；
 *   4. 删工作区登记、摘归档/置顶；
 *   5. `done`。
 * 任何一步失败都按相反顺序回滚；回滚干净就把空条目删掉，回滚不干净才留
 * `failed` 条目等启动恢复或人工处理（**绝不自动删字节**）。
 *
 * @module dsh-session-bin/workspace
 */

import { mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BinError, directorySize, MANIFEST_VERSION } from './trash.js'
import { encodeSegment, projectKey, projectKeyCollisions } from './paths.js'
import { createRuntime } from './runtime.js'

/**
 * 建一个工作区事务对象。
 *
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（只用来 `get` 可选服务与派发事件）。
 * @param {any} deps.registry `workspaceRegistry` 服务。
 * @param {ReturnType<import('./trash.js').createBin>} deps.bin 回收站。
 * @param {() => string | undefined} deps.sessionsRoot 当前会话存储根。
 * @param {{warn?: Function, info?: Function, debug?: Function}} [deps.logger]
 * @param {() => number} [deps.now] 时钟（测试注入）。
 */
export function createWorkspaceOps(deps) {
  const { ctx, registry, bin } = deps
  const runtime = createRuntime({
    ctx,
    registry,
    sessionsRoot: deps.sessionsRoot,
    logger: deps.logger,
    now: deps.now,
    stopTimeoutMs: deps.stopTimeoutMs,
    stopPollMs: deps.stopPollMs,
  })
  const { reason, isLive, quiesce, titleOf, pathKind, currentSessionsRoot, requireSessionsRoot, announceRemoved, log } = runtime
  const now = runtime.now
  /** 测试注入的崩溃点（生产不传）。 */
  const hooks = deps.hooks

  /**
   * 项目目录严格只包含本工作区的会话吗？
   *
   * projectKey 有损 + 目录是共享的：只要多出一个不认识的会话目录，整目录 rename 就会
   * 把别人的会话一起搬进回收站。所以「整目录」必须过这一关。
   *
   * @param {string} projectDir
   * @param {string[]} sessionIds
   * @returns {Promise<{exclusive: boolean, extra: string[], missing: string[]}>}
   */
  async function projectDirectoryExclusivity(projectDir, sessionIds) {
    let names
    try {
      names = (await readdir(projectDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return { exclusive: false, extra: [], missing: [] }
    }
    const expected = new Set(sessionIds.map((id) => encodeSegment(id)))
    return {
      exclusive: names.every((name) => expected.has(name)),
      extra: names.filter((name) => !expected.has(name)),
      missing: [...expected].filter((name) => !names.includes(name)),
    }
  }

  /**
   * 找出工作区会话名下的隐藏子代理会话（parentSession 链，`origin: 'subagent'`）。
   *
   * 它们通常不在 `workspace.sessionIds` 里，但目录和父会话在同一个 projectKey 下；
   * 逐会话删除时不带上就会变成没有父会话的孤儿。带不走的（cwd 落在别的项目目录）
   * 单独返回，让确认框说明。
   *
   * @param {string[]} accountedIds 工作区成员会话。
   * @param {string} targetKey 本次要动的项目目录键。
   * @returns {Promise<{sameProject: string[], otherProject: Array<{id: string, cwd: string}>}>}
   */
  async function collectSubagents(accountedIds, targetKey) {
    const sameProject = []
    const otherProject = []
    const persistence = ctx?.get?.('sessionPersistence')
    if (persistence === undefined || typeof persistence.list !== 'function') return { sameProject, otherProject }
    let snapshots
    try {
      snapshots = await persistence.list()
    } catch {
      return { sameProject, otherProject }
    }
    const headers = new Map()
    const childrenOf = new Map()
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (header === undefined || typeof header.id !== 'string') continue
      headers.set(header.id, header)
      if (typeof header.parentSession !== 'string') continue
      const bucket = childrenOf.get(header.parentSession)
      if (bucket === undefined) childrenOf.set(header.parentSession, [header.id])
      else bucket.push(header.id)
    }
    const seen = new Set(accountedIds)
    const queue = [...accountedIds]
    while (queue.length > 0) {
      for (const childId of childrenOf.get(queue.shift()) ?? []) {
        if (seen.has(childId)) continue
        const child = headers.get(childId)
        if (child === undefined || child.origin !== 'subagent') continue
        seen.add(childId)
        if (typeof child.cwd === 'string' && projectKey(child.cwd) === targetKey) sameProject.push(childId)
        else otherProject.push({ id: childId, cwd: typeof child.cwd === 'string' ? child.cwd : '' })
        queue.push(childId)
      }
    }
    return { sameProject, otherProject }
  }

  /**
   * 删除前先把要动的全部东西看清楚，并给出可行的搬运方式。
   *
   * @param {{workspaceId: string, callerSessionId?: string}} request
   * @returns {Promise<object>} plan（可直接交给 `execute`）。
   */
  async function survey(request) {
    const workspaceId = typeof request?.workspaceId === 'string' ? request.workspaceId.trim() : ''
    if (workspaceId === '') throw new BinError('session-bin/invalid-request', 'workspaceId is required')
    const workspace = registry.get?.(workspaceId)
    if (workspace === undefined) {
      throw new BinError('session-bin/unknown-workspace', `the workspace registry holds no workspace ${JSON.stringify(workspaceId)}`, { workspaceId })
    }
    const callerSessionId = typeof request?.callerSessionId === 'string' ? request.callerSessionId : undefined
    const sessionIds = [...workspace.sessionIds]
    if (callerSessionId !== undefined && sessionIds.includes(callerSessionId)) {
      throw new BinError(
        'session-bin/caller-session',
        'refusing to delete the workspace this operation is running in',
        { callerSessionId },
      )
    }

    const sessionsRoot = requireSessionsRoot()
    const key = projectKey(workspace.path)
    const projectDir = join(sessionsRoot, key)
    const hidden = await collectSubagents(sessionIds, key)
    const allSessionIds = [...sessionIds, ...hidden.sameProject.filter((id) => !sessionIds.includes(id))]
    const others = (registry.list?.() ?? [])
      .filter((entry) => entry.id !== workspace.id)
      .map((entry) => entry.path)
    const collisions = projectKeyCollisions(workspace.path, others)

    const kind = await pathKind(projectDir)
    let mode = 'none'
    let modeReason = 'no-project-directory'
    let extra = []
    let missing = []
    if (collisions.length > 0) {
      mode = 'per-session'
      modeReason = 'project-key-collision'
    } else if (kind === 'dir') {
      const exclusivity = await projectDirectoryExclusivity(projectDir, allSessionIds)
      extra = exclusivity.extra
      missing = exclusivity.missing
      if (exclusivity.exclusive) {
        mode = 'project'
        modeReason = 'project-directory-exclusive'
      } else {
        mode = 'per-session'
        modeReason = 'project-directory-not-exclusive'
      }
    } else if (kind !== 'missing') {
      throw new BinError(
        'session-bin/project-unreadable',
        `cannot read the project directory ${projectDir}`,
        { projectDir },
      )
    }

    const sessions = []
    for (const sessionId of allSessionIds) {
      const accounted = sessionIds.includes(sessionId)
      sessions.push({
        id: sessionId,
        title: await titleOf(sessionId),
        archived: accounted && (registry.archivedSessionIds ?? []).includes(sessionId),
        pinned: accounted && (registry.pinnedSessionIds ?? []).includes(sessionId),
        live: isLive(sessionId),
        accounted,
        subagent: !accounted,
      })
    }

    // 嵌套工作区：删外层会让内层的分组悬空（目录还回得来，但分组没了），确认框要警告。
    const separator = workspace.path.endsWith('/') || workspace.path.endsWith('\\') ? '' : (process.platform === 'win32' ? '\\' : '/')
    const nestedWorkspaces = (registry.list?.() ?? [])
      .filter((entry) => entry.id !== workspace.id && entry.path.startsWith(workspace.path + separator))
      .map((entry) => ({ id: entry.id, path: entry.path, title: entry.title }))

    const ordered = registry.list?.() ?? []
    const workspaceIndex = ordered.findIndex((entry) => entry.id === workspace.id)
    return {
      kind: 'workspace',
      workspace: {
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        index: workspaceIndex,
      },
      projectKey: key,
      projectDir,
      sessionsRoot,
      mode,
      modeReason,
      orphanSubagents: hidden.otherProject,
      extraSessionDirectories: extra,
      missingSessionDirectories: missing,
      collisions,
      nestedWorkspaces,
      sessions,
      live: sessions.filter((session) => session.live).map((session) => session.id),
      sessionCount: sessions.length,
      size: mode === 'project'
        ? await directorySize(projectDir)
        : await sessionDirectoriesSize(projectDir, allSessionIds),
    }
  }

  /**
   * @param {string} projectDir
   * @param {string[]} sessionIds
   * @returns {Promise<number>}
   */
  async function sessionDirectoriesSize(projectDir, sessionIds) {
    let total = 0
    for (const sessionId of sessionIds) {
      total += await directorySize(join(projectDir, encodeSegment(sessionId)))
    }
    return total
  }

  /**
   * 搬文件：整目录或逐会话。
   *
   * @param {object} plan
   * @param {string} entryId
   * @returns {Promise<{moved: Array<{from: string, to: string}>, skipped: string[]}>}
   */
  async function moveIntoBin(plan, entryId) {
    const destinationProjectDir = join(bin.sessionsDir(entryId), plan.projectKey)
    if (plan.mode === 'none') return { moved: [], skipped: plan.sessions.map((session) => session.id) }
    if (plan.mode === 'project') {
      // 不要预先 mkdir 目标目录：POSIX 允许 rename 目录到空目录，Windows 上
      // 「rename 到已存在目录」会失败。父目录 sessions/ 由 allocate 建好。
      await rename(plan.projectDir, destinationProjectDir)
      return { moved: [{ from: plan.projectDir, to: destinationProjectDir }], skipped: [] }
    }
    await mkdir(destinationProjectDir, { recursive: true })
    const moved = []
    const skipped = []
    for (const session of plan.sessions) {
      const from = join(plan.projectDir, encodeSegment(session.id))
      if ((await pathKind(from)) !== 'dir') {
        skipped.push(session.id)
        continue
      }
      const to = join(destinationProjectDir, encodeSegment(session.id))
      await rename(from, to)
      moved.push({ from, to })
    }
    return { moved, skipped }
  }

  /**
   * 把已搬进回收站的文件按相反顺序搬回去；返回搬不回去的项。
   * @param {Array<{from: string, to: string}>} moved
   * @returns {Promise<string[]>}
   */
  async function moveBack(moved) {
    const failures = []
    for (let index = moved.length - 1; index >= 0; index -= 1) {
      const item = moved[index]
      try {
        await mkdir(dirname(item.from), { recursive: true })
        await rename(item.to, item.from)
      } catch (error) {
        failures.push(`${item.to} -> ${item.from}: ${reason(error)}`)
      }
    }
    return failures
  }

  /**
   * 通过注册表 API 重新登记一个工作区（按原 id 拿不回来，只能按路径新建再改回标题/位置）。
   * @param {object} manifest
   * @returns {Promise<any>} 重建后的 workspace 实体，或 undefined。
   */
  async function recreateWorkspace(manifest) {
    const wanted = manifest.workspace
    if (wanted === undefined) return undefined
    const existing = registry.get?.(wanted.id)
    if (existing !== undefined) return existing
    try {
      const byPath = await registry.resolveByPath?.(wanted.path)
      if (byPath !== undefined) return byPath
    } catch {
      // 目录不存在时 resolveByPath 会抛；继续走 create 的报错路径。
    }
    const created = await registry.create(wanted.path)
    if (typeof wanted.title === 'string' && wanted.title !== '' && created.title !== wanted.title) {
      await created.setTitle(wanted.title)
    }
    try {
      await reposition(created.id, wanted.index)
    } catch {
      // 位置只是显示顺序；重建成功但排序失败不该让恢复失败。
    }
    return created
  }

  /**
   * 把工作区放回原来的显示位置（新建默认是置顶）。
   * @param {string} workspaceId
   * @param {number | undefined} wantedIndex
   */
  async function reposition(workspaceId, wantedIndex) {
    if (!Number.isSafeInteger(wantedIndex) || wantedIndex < 0) return
    const order = registry.list?.() ?? []
    const current = order.findIndex((entry) => entry.id === workspaceId)
    if (current < 0) return
    const without = order.filter((entry) => entry.id !== workspaceId)
    const target = Math.min(wantedIndex, without.length)
    if (target === current) return
    const anchor = without[target]
    if (anchor === undefined) await registry.insertBefore?.(workspaceId)
    else await registry.insertBefore?.(workspaceId, anchor.id)
  }

  /**
   * 把 manifest 里记的会话重新挂回工作区（已挂的跳过）。
   * @param {any} workspace
   * @param {object} manifest
   * @param {string[]} warnings
   */
  async function attachSessions(workspace, manifest, warnings) {
    for (const session of manifest.sessions) {
      const accounted = workspace.sessionIds.includes(session.id)
      if (accounted) continue
      try {
        await workspace.attachSession(session.id)
      } catch (error) {
        warnings.push(`attach ${session.id}: ${reason(error)}`)
      }
    }
  }

  /**
   * 还原归档 / 置顶标记。
   * @param {object} manifest
   * @param {string[]} warnings
   */
  async function restoreFlags(manifest, warnings) {
    for (const session of manifest.sessions) {
      if (session.archived === true) {
        try {
          await registry.archiveSession(session.id)
        } catch (error) {
          warnings.push(`archive ${session.id}: ${reason(error)}`)
        }
      }
      if (session.pinned === true) {
        try {
          await registry.pinSession(session.id)
        } catch (error) {
          warnings.push(`pin ${session.id}: ${reason(error)}`)
        }
      }
    }
  }

  /**
   * 执行一次已 survey 的删除。
   *
   * @param {object} plan `survey` 的返回值。
   * @returns {Promise<object>} 报告。
   */
  async function execute(plan) {
    const workspace = registry.get?.(plan.workspace.id)
    if (workspace === undefined) {
      throw new BinError(
        'session-bin/unknown-workspace',
        `the workspace ${JSON.stringify(plan.workspace.id)} disappeared before the delete started`,
        { workspaceId: plan.workspace.id },
      )
    }
    // survey 到 execute 之间可能有新会话落进项目目录：整目录 rename 会把它一起
    // 卷进回收站，却不在 manifest 里。搬运前再核对一次，宁可让用户重试。
    if (plan.mode === 'project') {
      const exclusivity = await projectDirectoryExclusivity(plan.projectDir, plan.sessions.map((session) => session.id))
      if (exclusivity.extra.length > 0) {
        throw new BinError(
          'session-bin/project-changed',
          `the project directory gained sessions after the plan was made: ${exclusivity.extra.join(', ')}`,
          { workspaceId: plan.workspace.id, extra: exclusivity.extra },
        )
      }
    }
    const warnings = []

    // 1. 停活：文件搬走前，所有写句柄必须松开。
    const busy = []
    for (const sessionId of plan.live) {
      const result = await quiesce(sessionId)
      warnings.push(...result.errors)
      if (!result.released) busy.push(sessionId)
    }
    if (busy.length > 0) {
      throw new BinError(
        'session-bin/session-busy',
        `refusing to delete while ${busy.length} session(s) are still writing: ${busy.join(', ')}`,
        { sessions: busy },
      )
    }

    // 2. 先把「打算做什么」写进回收站：崩溃恢复只认这份 manifest。
    const manifest = {
      version: MANIFEST_VERSION,
      kind: 'workspace',
      createdAt: new Date(now()).toISOString(),
      state: 'planned',
      workspace: {
        id: plan.workspace.id,
        path: plan.workspace.path,
        title: plan.workspace.title,
        createdAt: plan.workspace.createdAt,
        updatedAt: plan.workspace.updatedAt,
        index: plan.workspace.index,
      },
      projectKey: plan.projectKey,
      size: plan.size,
      sessions: plan.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        archived: session.archived,
        pinned: session.pinned,
        accounted: session.accounted !== false,
        subagent: session.subagent === true,
      })),
    }
    const entry = await bin.allocate(manifest)
    await hooks?.reach?.('after-plan', { entryId: entry.id })

    // 3. 搬文件。
    let moved = []
    let skipped = []
    try {
      const result = await moveIntoBin(plan, entry.id)
      moved = result.moved
      skipped = result.skipped
    } catch (error) {
      const rollbackFailures = await moveBack(moved)
      if (rollbackFailures.length === 0) await bin.removeEntry(entry.id).catch(() => {})
      else await bin.transition(entry.id, 'failed', { error: reason(error), rollbackFailures }).catch(() => {})
      throw new BinError('session-bin/move-failed', `moving into the recycle bin failed: ${reason(error)}`, {
        entryId: entry.id,
        rollbackFailures,
      })
    }

    await hooks?.reach?.('after-move', { entryId: entry.id })

    // 4. 删登记 + 摘归档/置顶。
    let registryDeleted = false
    try {
      // 插件自己的删除：文件夹留在原地，别让 OS 回收站监听器把它也搬走。
      deps.suppressFolderTrash?.(plan.workspace.id)
      registryDeleted = (await registry.delete?.(plan.workspace.id)) !== false
      for (const session of plan.sessions) {
        if (session.archived) await registry.unarchiveSession?.(session.id).catch((error) => warnings.push(`unarchive ${session.id}: ${reason(error)}`))
        if (session.pinned) await registry.unpinSession?.(session.id).catch((error) => warnings.push(`unpin ${session.id}: ${reason(error)}`))
      }
    } catch (error) {
      const rollbackFailures = await moveBack(moved)
      if (registryDeleted) await recoverRegistration(manifest, rollbackFailures, warnings)
      if (rollbackFailures.length === 0) await bin.removeEntry(entry.id).catch(() => {})
      else await bin.transition(entry.id, 'failed', { error: reason(error), rollbackFailures }).catch(() => {})
      throw new BinError('session-bin/registry-failed', `removing the workspace registration failed: ${reason(error)}`, {
        entryId: entry.id,
        rollbackFailures,
      })
    }

    await hooks?.reach?.('after-registry', { entryId: entry.id })
    const finished = await bin.transition(entry.id, 'done', { finishedAt: new Date(now()).toISOString() })
    for (const moved of finished.sessions) announceRemoved(moved.id)
    log('info', `session-bin: workspace ${plan.workspace.id} moved to entry ${entry.id} (${plan.mode})`)
    return {
      entryId: entry.id,
      mode: plan.mode,
      moved: moved.length,
      skipped,
      sessionCount: plan.sessions.length,
      warnings,
      manifest: finished,
    }
  }

  /**
   * 回滚时把工作区登记也补回来。
   * @param {object} manifest
   * @param {string[]} failures
   * @param {string[]} warnings
   */
  async function recoverRegistration(manifest, failures, warnings) {
    try {
      const workspace = await recreateWorkspace(manifest)
      if (workspace === undefined) return
      await attachSessions(workspace, manifest, warnings)
      await restoreFlags(manifest, warnings)
    } catch (error) {
      failures.push(`re-register workspace: ${reason(error)}`)
    }
  }

  /**
   * 从回收站恢复一个工作区条目。
   *
   * @param {string} entryId
   * @returns {Promise<object>} 报告。
   */
  async function restore(entryId) {
    const manifest = await bin.readManifest(entryId)
    // manifest 才是清单：条目里若多出未登记的会话目录（例如整目录搬移期间
    // 新建了会话），恢复/删除都不能把它静默丢掉。
    const entry = { id: entryId, manifest }
    const unaccounted = await unaccountedSessionDirs(entry)
    if (unaccounted.length > 0) {
      throw new BinError(
        'session-bin/unaccounted-data',
        `entry ${entryId} holds session data the manifest cannot account for: ${unaccounted.join(', ')}`,
        { entryId, unaccounted },
      )
    }
    if (manifest.kind === 'session') {
      if (typeof deps.restoreSession !== 'function') {
        throw new BinError('session-bin/wrong-kind', `entry ${entryId} is a session entry, and no session restorer is wired`, { entryId })
      }
      return await deps.restoreSession(manifest, entryId)
    }
    if (manifest.kind !== 'workspace') {
      throw new BinError('session-bin/wrong-kind', `entry ${entryId} is a ${manifest.kind} entry`, { entryId })
    }
    if (manifest.state !== 'done') {
      throw new BinError(
        'session-bin/not-done',
        `entry ${entryId} is ${manifest.state}; only a completed delete can be restored`,
        { entryId, state: manifest.state },
      )
    }
    const sessionsRoot = requireSessionsRoot()
    const projectDir = join(sessionsRoot, manifest.projectKey)
    const warnings = []
    const moved = []
    try {
      for (const session of manifest.sessions) {
        const encoded = encodeSegment(session.id)
        const from = join(bin.sessionsDir(entryId), manifest.projectKey, encoded)
        const to = join(projectDir, encoded)
        const fromKind = await pathKind(from)
        if (fromKind !== 'dir') {
          if ((await pathKind(to)) === 'dir') continue
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
        await mkdir(projectDir, { recursive: true })
        await rename(from, to)
        moved.push({ from, to })
      }
    } catch (error) {
      const rollbackFailures = await moveBack(moved)
      throw new BinError(
        'session-bin/restore-failed',
        `restoring ${entryId} failed: ${reason(error)}`,
        { entryId, rollbackFailures },
      )
    }

    let workspace
    let workspaceRestored = false
    const workspacePathKind = await pathKind(manifest.workspace.path)
    if (workspacePathKind === 'dir') {
      try {
        workspace = await recreateWorkspace(manifest)
        workspaceRestored = workspace !== undefined
      } catch (error) {
        warnings.push(`re-register workspace: ${reason(error)}`)
      }
    } else {
      warnings.push(`workspace directory is missing (${workspacePathKind}): ${manifest.workspace.path}`)
    }

    const attached = []
    if (workspace !== undefined) {
      for (const session of manifest.sessions) {
        if (workspace.sessionIds.includes(session.id)) continue
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
      // 数据已经回位、登记也恢复了：条目删不掉只算遗留垃圾，不该报成恢复失败。
      warnings.push(`remove recycle-bin entry: ${reason(error)}`)
    }
    log('info', `session-bin: restored entry ${entryId} to ${projectDir}`)
    return {
      entryId,
      restoredTo: projectDir,
      workspaceId: workspace?.id,
      workspaceRestored,
      restored: manifest.sessions.map((session) => session.id),
      attached,
      warnings,
    }
  }

  /**
   * 永久删除（唯一删字节的动作）。
   *
   * @param {string[] | undefined} entryIds 指定条目；缺省清空全部。
   * @returns {Promise<{purged: string[], errors: string[]}>}
   */
  async function purge(entryIds) {
    const selected = Array.isArray(entryIds) ? new Set(entryIds.filter((id) => typeof id === 'string')) : null
    const { entries } = await bin.scan()
    const purged = []
    const errors = []
    for (const entry of entries) {
      if (selected !== null && !selected.has(entry.id)) continue
      if (entry.manifest.state === 'planned') {
        errors.push(`${entry.id}: still planned (run startup recovery before purging)`)
        continue
      }
      const unaccounted = await unaccountedSessionDirs(entry)
      if (unaccounted.length > 0) {
        errors.push(`${entry.id}: refuses to purge data the manifest cannot account for (${unaccounted.join(', ')})`)
        continue
      }
      const present = await presentSessions(entry)
      try {
        await bin.removeEntry(entry.id)
        purged.push(entry.id)
      } catch (error) {
        errors.push(`${entry.id}: ${reason(error)}`)
        continue
      }
      for (const sessionId of present) {
        try {
          const table = ctx?.get?.('storageDomain')?.get?.('session_projcache')?.table?.('sessions')
          await table?.delete?.(sessionId)
        } catch (error) {
          errors.push(`${entry.id} projection cache ${sessionId}: ${reason(error)}`)
        }
      }
    }
    return { purged, errors }
  }

  /**
   * 回收站条目里实际还存在的会话 id（以磁盘为准，不信 manifest）。
   * @param {{id: string, manifest: object}} entry
   * @returns {Promise<string[]>}
   */
  async function presentSessions(entry) {
    const found = []
    const projectDir = join(bin.sessionsDir(entry.id), entry.manifest.projectKey)
    let names
    try {
      names = (await readdir(projectDir, { withFileTypes: true })).filter((child) => child.isDirectory())
    } catch {
      return found
    }
    const known = new Set(entry.manifest.sessions.map((session) => encodeSegment(session.id)))
    for (const child of names) {
      if (known.has(child.name)) {
        const account = entry.manifest.sessions.find((session) => encodeSegment(session.id) === child.name)
        found.push(account.id)
      }
    }
    return found
  }

  /**
   * 回收站条目数据目录里的全部子目录名（不认识也算）。
   * @param {{id: string, manifest: object}} entry
   * @returns {Promise<string[]>}
   */
  async function binProjectDirs(entry) {
    try {
      const children = await readdir(join(bin.sessionsDir(entry.id), entry.manifest.projectKey), { withFileTypes: true })
      return children.filter((child) => child.isDirectory()).map((child) => child.name)
    } catch {
      return []
    }
  }

  /**
   * 条目里 manifest 没有登记的会话目录；这些字节只能由人工判断，不能自动搬/删。
   * @param {{id: string, manifest: object}} entry
   * @returns {Promise<string[]>}
   */
  async function unaccountedSessionDirs(entry) {
    const known = new Set(entry.manifest.sessions.map((session) => encodeSegment(session.id)))
    return (await binProjectDirs(entry)).filter((name) => !known.has(name))
  }

  /**
   * 列出回收站内容（供面板）。
   * @returns {Promise<object>}
   */
  async function list() {
    const { root, entries, broken } = await bin.scan()
    const rows = []
    for (const entry of entries) {
      // 会话条目允许 `workspace: null`（删的时候会话本来就没有归属），不能只判 undefined。
      const record = entry.manifest.workspace
      rows.push({
        id: entry.id,
        kind: entry.manifest.kind,
        state: entry.manifest.state,
        createdAt: entry.manifest.createdAt,
        finishedAt: entry.manifest.finishedAt,
        error: entry.manifest.error,
        title: entry.manifest.kind === 'workspace'
          ? (record?.title ?? '')
          : (entry.manifest.sessions[0]?.title ?? ''),
        workspace: record === undefined || record === null
          ? null
          : {
              id: record.id,
              path: record.path,
              title: record.title,
            },
        sessions: entry.manifest.sessions.map((session) => ({ id: session.id, title: session.title })),
        sessionCount: entry.manifest.sessions.length,
        // 大回收站优化：manifest 里存过 size 就直接用；老条目统计一次后补写，避免每次 list 都递归扫盘。
        size: await (async () => {
          // 0 表示「源目录统计时是空的」，这时条目里至少还有 manifest，补一次实际大小。
          if (typeof entry.manifest.size === 'number' && entry.manifest.size > 0) return entry.manifest.size
          const size = await bin.entrySize(entry.id)
          const updated = await bin.recordSize(entry.id, size)
          if (updated !== undefined) entry.manifest = updated
          return size
        })(),
      })
    }
    return { root, entries: rows, broken }
  }

  /**
   * 启动恢复：只收敛、绝不删字节。
   *
   * @returns {Promise<{recovered: Array<{id: string, action: string}>, unresolved: string[], errors: string[]}>}
   */
  async function recover() {
    const recovered = []
    const unresolved = []
    const errors = []
    const { entries } = await bin.scan()
    for (const entry of entries) {
      if (entry.manifest.state !== 'planned') continue
      const manifest = entry.manifest
      try {
        const present = await presentSessions(entry)
        const dataDirs = await binProjectDirs(entry)
        const registered = manifest.kind === 'workspace' && registry.get?.(manifest.workspace?.id) !== undefined
        if (present.length === 0 && dataDirs.length > 0) {
          // 目录里有东西，但 manifest 一个都对不上：不认识的东西绝不丢。
          unresolved.push(entry.id)
          errors.push(`${entry.id}: the recycle bin holds data the manifest cannot account for (${dataDirs.join(', ')})`)
          continue
        }

        // 会话条目：文件已进回收站就把「摘登记」补完；没进就丢掉空条目。
        if (manifest.kind === 'session') {
          if (present.length === 0) {
            await bin.removeEntry(entry.id)
            recovered.push({ id: entry.id, action: 'discarded-empty' })
            continue
          }
          for (const session of present) {
            for (const workspace of registry.list?.() ?? []) {
              if (workspace.sessionIds.includes(session)) await workspace.detachSession(session)
            }
            const account = manifest.sessions.find((entrySession) => entrySession.id === session)
            if (account?.archived) await registry.unarchiveSession?.(session).catch((error) => errors.push(`${entry.id} unarchive ${session}: ${reason(error)}`))
            if (account?.pinned) await registry.unpinSession?.(session).catch((error) => errors.push(`${entry.id} unpin ${session}: ${reason(error)}`))
          }
          await bin.transition(entry.id, 'done', { finishedAt: new Date(now()).toISOString(), recoveredAt: new Date(now()).toISOString() })
          recovered.push({ id: entry.id, action: 'completed' })
          continue
        }

        if (manifest.kind !== 'workspace') {
          unresolved.push(entry.id)
          errors.push(`${entry.id}: unknown entry kind ${JSON.stringify(manifest.kind)}`)
          continue
        }
        if (present.length > 0) {
          // 文件已在回收站：把「登记删除」补完。
          if (!registered) {
            await bin.transition(entry.id, 'done', { finishedAt: new Date(now()).toISOString(), recoveredAt: new Date(now()).toISOString() })
            recovered.push({ id: entry.id, action: 'completed' })
            continue
          }
          deps.suppressFolderTrash?.(manifest.workspace.id)
          await registry.delete?.(manifest.workspace.id)
          for (const session of manifest.sessions) {
            if (session.archived) await registry.unarchiveSession?.(session.id).catch((error) => errors.push(`${entry.id} unarchive ${session.id}: ${reason(error)}`))
            if (session.pinned) await registry.unpinSession?.(session.id).catch((error) => errors.push(`${entry.id} unpin ${session.id}: ${reason(error)}`))
          }
          await bin.transition(entry.id, 'done', { finishedAt: new Date(now()).toISOString(), recoveredAt: new Date(now()).toISOString() })
          recovered.push({ id: entry.id, action: 'completed' })
          continue
        }

        // 文件没有进回收站：要么什么都没做，要么登记已删而文件还在源目录。
        if (registered) {
          await bin.removeEntry(entry.id)
          recovered.push({ id: entry.id, action: 'discarded-noop' })
          continue
        }
        const sourcePresent = (await pathKind(join(requireSessionsRoot(), manifest.projectKey))) === 'dir'
        if (sourcePresent) {
          const workspace = await recreateWorkspace(manifest)
          const warnings = []
          if (workspace !== undefined) await attachSessions(workspace, manifest, warnings)
          errors.push(...warnings.map((warning) => `${entry.id} ${warning}`))
          await bin.removeEntry(entry.id)
          recovered.push({ id: entry.id, action: 're-registered' })
          continue
        }
        await bin.removeEntry(entry.id)
        recovered.push({ id: entry.id, action: 'discarded-empty' })
      } catch (error) {
        unresolved.push(entry.id)
        errors.push(`${entry.id}: ${reason(error)}`)
      }
    }
    if (recovered.length > 0) log('info', `session-bin: startup recovery handled ${recovered.length} entr(ies)`)
    if (errors.length > 0) log('warn', `session-bin: startup recovery reported ${errors.length} problem(s)`)
    return { recovered, unresolved, errors }
  }

  return { survey, execute, restore, purge, list, recover, quiesce, isLive, currentSessionsRoot }
}
