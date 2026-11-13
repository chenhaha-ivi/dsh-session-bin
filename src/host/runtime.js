/**
 * 事务层共用的运行时探针：会话活不活、能不能停、存储根在哪、路径是什么状态。
 *
 * workspace.js（删工作区）和 session.js（删会话）都要问同样几个问题，
 * 所以抽在这里，避免两套「停活」逻辑漂移。
 *
 * @module dsh-session-bin/runtime
 */

import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DEFAULT_STOP_TIMEOUT_MS = 3000
const DEFAULT_STOP_POLL_MS = 50

/**
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（只用 `get` 拿可选服务、`parallel` 派发停止事件）。
 * @param {any} deps.registry `workspaceRegistry` 服务（读会话 header 用）。
 * @param {() => string | undefined} [deps.sessionsRoot] 会话存储根来源。
 * @param {{warn?: Function, info?: Function, debug?: Function}} [deps.logger]
 * @param {() => number} [deps.now] 时钟（测试注入）。
 * @param {number} [deps.stopTimeoutMs] 停活最长等待。
 * @param {number} [deps.stopPollMs] 停活轮询间隔。
 */
export function createRuntime(deps) {
  const { ctx, registry, logger } = deps
  const now = deps.now ?? (() => Date.now())
  const stopTimeoutMs = Number.isFinite(deps.stopTimeoutMs) && deps.stopTimeoutMs >= 0
    ? deps.stopTimeoutMs
    : DEFAULT_STOP_TIMEOUT_MS
  const stopPollMs = Number.isFinite(deps.stopPollMs) && deps.stopPollMs > 0
    ? deps.stopPollMs
    : DEFAULT_STOP_POLL_MS

  /** 一条可读的错误信息。 */
  const reason = (error) => (error instanceof Error && error.message !== '' ? error.message : String(error))

  /** 记一行日志；日志失败不影响事务。 */
  const log = (level, message) => {
    try {
      logger?.[level]?.(message)
    } catch {
      // 忽略：日志不是业务。
    }
  }

  /** 当前会话存储根；未配置时按 DSH home 惯例推导，推不出来返回 undefined。 */
  function currentSessionsRoot() {
    const configured = deps.sessionsRoot?.()
    if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
    const root = ctx?.sessionPersistence?.root
    if (typeof root === 'string' && root.trim() !== '') return resolve(root)
    const home = process.env.DSH_HOME
    if (typeof home === 'string' && home.trim() !== '') return resolve(join(home, 'sessions'))
    return undefined
  }

  /** 必须拿到会话存储根，拿不到就拒绝（绝不猜一个路径去动文件）。 */
  function requireSessionsRoot() {
    const root = currentSessionsRoot()
    if (root === undefined) {
      throw new Error('cannot locate the session storage root (neither sessionPersistence.root nor DSH_HOME is available)')
    }
    return root
  }

  /** 会话是否还活在本进程里（打开 / 跑回合 / 被 agent 持有）。 */
  function isLive(sessionId) {
    try {
      if (ctx?.get?.('sessions')?.get?.(sessionId) !== undefined) return true
      if (ctx?.get?.('agents')?.get?.(sessionId) !== undefined) return true
    } catch {
      // 服务探测失败按「不活」处理，文件操作本身还有错误兜底。
    }
    return false
  }

  /**
   * 会话是否**正在跑一轮**（不只是打开着）：官方 agent 的 status 是 `running`。
   * 空闲但打开的会话由 {@link isLive} 判定，仍然允许停活后搬运/回收。
   * @param {string} sessionId
   * @returns {boolean}
   */
  function isRunning(sessionId) {
    try {
      const agent = ctx?.get?.('agents')?.get?.(sessionId)
      return agent?.status === 'running'
    } catch {
      return false
    }
  }

  /** 读一个会话的缓存标题（只读；拿不到返回空串）。 */
  async function titleOf(sessionId) {
    try {
      const cache = ctx?.get?.('sessionProjectionCache')
      if (cache === undefined || typeof cache.cachedSnapshot !== 'function') return ''
      const header = await registry.readSessionHeader?.(sessionId)
      if (header === undefined) return ''
      const title = cache.cachedSnapshot(header, ['title'])?.values?.title
      return typeof title === 'string' ? title : ''
    } catch {
      return ''
    }
  }

  /**
   * 写打开探针：能拿到写句柄就说明没有活跃写者（立刻 close 归还）。
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async function writeLeaseHeld(sessionId) {
    const persistence = ctx?.get?.('sessionPersistence')
    if (persistence === undefined || typeof persistence.open !== 'function') return false
    try {
      const handle = await persistence.open(sessionId, 'write')
      try {
        await handle?.close?.()
      } catch {
        // close 失败不影响「拿到过句柄 = 没有活跃写者」的判断。
      }
      return false
    } catch (error) {
      // 会话从未物化 / 已不在存储里：没有写者。
      if (error !== null && typeof error === 'object' && error.name === 'SessionAlreadyOwnedError') return true
      return false
    }
  }

  /**
   * 让一个会话松开对本进程的占用：先请停止提供方结束它的工作，再依次拆掉
   * SessionStore 的条目（`entry.detach()`）和 agents 注册表里的条目
   * （`detachEntered()`，停活事件不会摘它），最后用写打开探针确认租约真的没了。
   *
   * @param {string} sessionId
   * @returns {Promise<{released: boolean, errors: string[]}>}
   */
  async function quiesce(sessionId) {
    const errors = []
    if (!isLive(sessionId)) return { released: true, errors }
    if (typeof ctx?.parallel === 'function') {
      try {
        await ctx.parallel('workspace/session-stop', { sessionId })
      } catch (error) {
        errors.push(`stop providers: ${reason(error)}`)
      }
    }
    try {
      const entry = ctx?.get?.('sessions')?.store?.get?.(sessionId)
      if (entry !== undefined && typeof entry.detach === 'function') entry.detach()
      else errors.push('the session store exposes no detach() for this session')
    } catch (error) {
      errors.push(`store detach: ${reason(error)}`)
    }
    // 停活事件只让 agent 停回合，不会把它从注册表摘掉；agent 还活着的话，
    // `isLive` 永远为真，删除永远等不到「松开」。这里把 agent 条目也驱逐掉。
    try {
      const agentsSvc = ctx?.get?.('agents')
      const agentEntry = agentsSvc?.store?.get?.(sessionId)
      if (agentEntry !== undefined) {
        if (typeof agentsSvc.detachEntered === 'function') agentsSvc.detachEntered(agentEntry)
        else if (typeof agentEntry.detach === 'function') agentEntry.detach()
        else errors.push('the agent registry exposes no detachEntered() for this session')
      }
    } catch (error) {
      errors.push(`agent detach: ${reason(error)}`)
    }

    const deadline = now() + stopTimeoutMs
    while (now() < deadline) {
      if (!isLive(sessionId) && !(await writeLeaseHeld(sessionId))) return { released: true, errors }
      await new Promise((settle) => setTimeout(settle, stopPollMs))
    }
    const released = !isLive(sessionId) && !(await writeLeaseHeld(sessionId))
    if (!released) errors.push('the session is still writing after the stop timeout')
    return { released, errors }
  }

  /**
   * 通知客户端把一行会话从列表里去掉。
   *
   * 冷会话没有 live 条目，驱逐时不会发 `session/disposed` → 控制器就不会发
   * `api-session/removed`；侧栏于是把这一行挪进「未分组」，点开还会 `session/not-found`。
   * 这里补一条纯通知：不创建、不写入、不碰任何缓存。
   * @param {string} sessionId
   */
  function announceRemoved(sessionId) {
    try {
      ctx?.emit?.('api-session/removed', sessionId)
    } catch {
      // 通知不是业务；发不出去也不影响已经完成的事务。
    }
  }

  /** 目录 / 文件 / 不存在 / 读不了。 */
  async function pathKind(path) {
    try {
      return (await stat(path)).isDirectory() ? 'dir' : 'other'
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return 'missing'
      return 'unreadable'
    }
  }

  return {
    now,
    reason,
    log,
    currentSessionsRoot,
    requireSessionsRoot,
    isLive,
    isRunning,
    titleOf,
    quiesce,
    announceRemoved,
    pathKind,
  }
}
