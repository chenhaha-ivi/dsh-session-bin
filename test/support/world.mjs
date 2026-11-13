/**
 * 测试用的假世界：假注册表、假 sessions、假 ctx + 真回收站 / 真文件系统。
 * 文件全部落在 `.test-tmp/`，不碰真实 DSH home。
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createBin } from '../../src/host/trash.js'
import { projectKey } from '../../src/host/paths.js'
import { createRuntime } from '../../src/host/runtime.js'
import { createWorkspaceOps } from '../../src/host/workspace.js'
import { createSessionOps } from '../../src/host/session.js'
import { createMoveOps } from '../../src/host/move.js'
import { createFakePersistence, loadPersistenceFromDisk } from './persistence.mjs'
import { tempHome } from '../helpers.mjs'

/** 静默 logger。 */
export const silentLogger = { warn() {}, info() {}, debug() {}, error() {} }

class FakeWorkspace {
  constructor(registry, id, record, options = {}) {
    this.registry = registry
    this.id = id
    this.record = record
    this.attachFails = options.attachFails === true
  }

  get path() {
    return this.record.path
  }

  get title() {
    return this.record.title
  }

  get createdAt() {
    return this.record.createdAt
  }

  get updatedAt() {
    return this.record.updatedAt
  }

  /** 与真实注册表一致：按 header 的 cwd 索引过滤记录里的会话。 */
  get sessionIds() {
    return this.record.sessionIds.filter((id) => this.registry.sessionPaths.get(id) === this.record.path
      || this.registry.missingSessionPaths.has(id))
  }

  async setTitle(title) {
    this.record = { ...this.record, title, updatedAt: new Date().toISOString() }
  }

  async attachSession(id) {
    if (this.attachFails) throw new Error('attach refused (test)')
    this.registry.sessionPaths.set(id, this.record.path)
    if (!this.record.sessionIds.includes(id)) {
      this.record = { ...this.record, sessionIds: [id, ...this.record.sessionIds] }
    }
  }

  async detachSession(id) {
    this.record = { ...this.record, sessionIds: this.record.sessionIds.filter((entry) => entry !== id) }
  }
}

/**
 * 与 WorkspaceRegistry 的公开面一致的假实现（同步 get/list，异步写操作）。
 * @param {{workspaces?: Array<{id: string, path: string, title: string, sessionIds?: string[]}>, archived?: string[], pinned?: string[], deleteFails?: boolean}} [options]
 */
export function createFakeRegistry(options = {}) {
  const entities = new Map()
  const order = []
  const archived = new Set(options.archived ?? [])
  const pinned = new Set(options.pinned ?? [])
  let counter = 0
  const now = () => new Date().toISOString()

  const registry = {
    headers: new Map(),
    sessionPaths: new Map(),
    missingSessionPaths: new Set(),
    invalidSessionPaths: new Map(),
    get: (id) => entities.get(id),
    list: () => order.map((id) => entities.get(id)),
    async create(path, title) {
      const existing = [...entities.values()].find((workspace) => workspace.path === path)
      if (existing !== undefined) return existing
      let id
      do {
        id = `ws-${++counter}`
      } while (entities.has(id))
      const entity = new FakeWorkspace(registry, id, {
        path,
        title: title ?? path.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace',
        sessionIds: [],
        createdAt: now(),
        updatedAt: now(),
      }, { attachFails: (options.attachFailsFor ?? []).includes(id) })
      entities.set(id, entity)
      order.unshift(id)
      return entity
    },
    async resolveByPath(path) {
      return [...entities.values()].find((workspace) => workspace.path === path)
    },
    async readSessionHeader(sessionId) {
      const indexed = registry.headers.get(sessionId)
      if (indexed !== undefined) return indexed
      const header = options.headers?.[sessionId]
      if (header !== undefined) return header
      for (const workspace of entities.values()) {
        if (workspace.record.sessionIds.includes(sessionId)) {
          return { version: 4, id: sessionId, cwd: workspace.record.path, createdAt: 1 }
        }
      }
      throw new Error(`cannot validate session '${sessionId}': session persistence holds no such session`)
    },
    async delete(id) {
      if (options.deleteFails === true) throw new Error('workspace delete rejected (test)')
      const workspace = entities.get(id)
      if (workspace === undefined) return false
      entities.delete(id)
      order.splice(order.indexOf(id), 1)
      return true
    },
    async insertBefore(id, beforeId) {
      const at = order.indexOf(id)
      if (at < 0) throw new Error(`unknown workspace ${id}`)
      order.splice(at, 1)
      if (beforeId === undefined) {
        order.push(id)
        return
      }
      const anchor = order.indexOf(beforeId)
      if (anchor < 0) throw new Error(`unknown anchor ${beforeId}`)
      order.splice(anchor, 0, id)
    },
    get archivedSessionIds() {
      return [...archived]
    },
    get pinnedSessionIds() {
      return [...pinned]
    },
    async archiveSession(id) {
      archived.add(id)
    },
    async unarchiveSession(id) {
      archived.delete(id)
    },
    async pinSession(id) {
      pinned.add(id)
    },
    async unpinSession(id) {
      pinned.delete(id)
    },
  }

  for (const workspace of options.workspaces ?? []) {
    const id = workspace.id ?? `ws-${++counter}`
    entities.set(id, new FakeWorkspace(registry, id, {
      sessionIds: [],
      createdAt: now(),
      updatedAt: now(),
      ...workspace,
      id,
    }, { attachFails: (options.attachFailsFor ?? []).includes(id) }))
    order.push(id)
  }
  return registry
}

/**
 * 假 sessions 服务（`ctx.get('sessions')`）：活会话可以被 detach 释放。
 * @param {{live?: string[], detachable?: boolean}} [options]
 */
export function createFakeSessions(options = {}) {
  const live = new Set(options.live ?? [])
  const sessions = {
    get: (id) => (live.has(id) ? { id } : undefined),
    list: () => [...live],
    store: {
      get: (id) => {
        if (!live.has(id)) return undefined
        return {
          detach: () => {
            if (options.detachable === false) throw new Error('detach refused (test)')
            live.delete(id)
          },
        }
      },
    },
  }
  return { sessions, live }
}

/**
 * 假 agents 服务（`ctx.get('agents')`）：官方注册表只有 `detachEntered(entry)`
 * 这一条驱逐路径，插件必须走它，否则 agent 一直活着、`isLive` 永远为真。
 * @param {{live?: string[], running?: string[], detachable?: boolean}} [options]
 */
export function createFakeAgents(options = {}) {
  const live = new Set(options.live ?? [])
  const running = new Set(options.running ?? [])
  const view = (id) => (live.has(id) ? { id, status: running.has(id) ? 'running' : 'idle' } : undefined)
  const agents = {
    get: view,
    store: {
      get: view,
    },
    detachEntered: (entry) => {
      if (options.detachable === false) throw new Error('agent eviction refused (test)')
      live.delete(entry.id)
    },
  }
  return { agents, live }
}

/**
 * 组装一个可操作的世界。
 *
 * @param {object} options
 * @param {string[]} [options.sessionIds] 工作区名下的会话 id
 * @param {string[]} [options.extraDirs] 项目目录里多出来的会话目录
 * @param {string[]} [options.live] 活会话
 * @param {string[]} [options.running] 正在跑回合的会话（agent status=running）
 * @param {boolean} [options.detachable] 活会话能否被释放
 * @param {boolean} [options.deleteFails] 注册表删除是否失败
 * @param {string[]} [options.archived]
 * @param {string[]} [options.pinned]
 */
export async function makeWorld(options = {}) {
  const home = options.home ?? await tempHome('bin-')
  const workspacePath = join(home, 'ws')
  await mkdir(workspacePath, { recursive: true })
  const sessionsRoot = join(home, 'sessions')
  const key = projectKey(workspacePath)
  const projectDir = join(sessionsRoot, key)
  const sessionIds = options.sessionIds ?? []
  for (const id of [...sessionIds, ...(options.extraDirs ?? [])]) {
    await mkdir(join(projectDir, id), { recursive: true })
  }

  const persistence = options.loadFromDisk === true
    ? await loadPersistenceFromDisk(sessionsRoot)
    : createFakePersistence({ root: sessionsRoot, failCreate: options.failCreate, sizeBytes: options.sizeBytes })
  if (options.seedSessions !== false && options.loadFromDisk !== true) {
    for (const id of sessionIds) {
      persistence.seed(
        { version: 4, id, cwd: workspacePath, createdAt: 1, isSeeded: options.seeded === true, delegationDepth: 0 },
        [{ seq: 0, type: 'turn/start', data: {} }, { seq: 1, type: 'turn/end', data: {} }],
      )
    }
  }

  for (const id of options.subagents ?? []) {
    persistence.seed(
      { version: 4, id, cwd: workspacePath, parentSession: 'session-1', origin: 'subagent', createdAt: 2, isSeeded: false, delegationDepth: 1 },
      [{ seq: 0, type: 'turn/start', data: {} }],
    )
    await mkdir(join(projectDir, id), { recursive: true })
  }

  const registry = createFakeRegistry({
    workspaces: options.workspaces ?? [{ id: 'ws-1', path: workspacePath, title: 'demo', sessionIds }],
    archived: options.archived,
    pinned: options.pinned,
    deleteFails: options.deleteFails,
    attachFailsFor: options.attachFailsFor,
  })
  for (const id of [...sessionIds, ...(options.subagents ?? [])]) {
    registry.sessionPaths.set(id, workspacePath)
  }
  const { sessions, live } = createFakeSessions({ live: options.live, detachable: options.detachable })
  const { agents, live: liveAgents } = createFakeAgents({ live: options.live, running: options.running, detachable: options.agentsDetachable })
  const deletedCacheRows = []
  const cacheRows = new Map()
  const services = {
    sessions: options.noSessionsService === true ? undefined : sessions,
    sessionPersistence: persistence,
    agents,
    storageDomain: {
      get: () => ({
        table: () => ({
          get: (id) => cacheRows.get(id),
          put: async (id, value) => { cacheRows.set(id, value) },
          delete: async (id) => { deletedCacheRows.push(id); cacheRows.delete(id) },
        }),
      }),
    },
  }
  const emitted = []
  const ctx = {
    get: (name) => services[name],
    sessionPersistence: persistence,
    parallel: async () => {},
    emit: (name, payload) => { emitted.push([name, payload]) },
    logger: silentLogger,
  }
  const bin = createBin({ home })
  const deps = {
    ctx,
    registry,
    bin,
    sessionsRoot: () => sessionsRoot,
    logger: silentLogger,
    stopTimeoutMs: 80,
    stopPollMs: 10,
    hooks: options.hooks,
  }
  const runtime = createRuntime(deps)
  const sessionOps = createSessionOps({ ...deps, runtime })
  const workspaceOps = createWorkspaceOps({ ...deps, runtime, restoreSession: sessionOps.restoreSession })
  const moveOps = createMoveOps({ ...deps, runtime })
  const ops = {
    survey: (payload) => (typeof payload?.sessionId === 'string' && payload.sessionId.trim() !== ''
      ? sessionOps.surveySession(payload)
      : workspaceOps.survey(payload)),
    execute: (plan) => (plan?.kind === 'session' ? sessionOps.executeSession(plan) : workspaceOps.execute(plan)),
    restore: workspaceOps.restore,
    purge: workspaceOps.purge,
    list: workspaceOps.list,
    recover: workspaceOps.recover,
    relocate: moveOps.relocateSession,
    recoverMoves: moveOps.recoverMoves,
  }

  return {
    home,
    workspacePath,
    workspaceId: 'ws-1',
    liveAgents,
    sessionsRoot,
    projectKey: key,
    projectDir,
    registry,
    sessions,
    live,
    emitted,
    ctx,
    bin,
    ops,
    workspaceOps,
    sessionOps,
    moveOps,
    persistence,
    deletedCacheRows,
    cacheRows,
  }
}
