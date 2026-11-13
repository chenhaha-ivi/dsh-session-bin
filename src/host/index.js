/**
 * dsh-workspace-bin — Host 半边。
 *
 * 刻意 **不 import 任何 `@deepseek-ai/*` 包**：所有协作者都通过 cordis 服务拿
 * （`workspaceRegistry` / `sessionPersistence` / `sessions` / `connection`），
 * 这样即使 profile 的 node_modules 布局变了，插件也能加载。
 *
 * 激活时只做两件事：
 *   1. 挂一个精确路由 `/api/workspace-bin`（五个端点，见 routes.js）；
 *   2. 跑一次启动恢复（回收站里 `planned` 的条目收敛，**绝不自动删字节**）。
 *
 * @module dsh-workspace-bin
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBin } from './trash.js'
import { createRuntime } from './runtime.js'
import { createWorkspaceOps } from './workspace.js'
import { createSessionOps } from './session.js'
import { createMoveOps } from './move.js'
import { createRouteHandler } from './routes.js'
import { createWorkspaceFolderWatcher } from './workspace-watch.js'
import { trashPathToOs } from './os-trash.js'

/** 插件名（必须与 package.json 的 name 一致）。 */
export const name = 'dsh-workspace-bin'

/** 精确路由：挂在整个 `/api` 载体上，Host/Origin 校验由 connection 先做完。 */
export const ROUTE = '/api/workspace-bin'

/**
 * 激活前置的宿主服务。
 *
 * 缺任一个都说明这个 profile 没有「工作区」这套概念，插件不该加载。
 */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/**
 * 解析 DSH home：配置 > `$DSH_HOME` > `~/.dsh`（与 dsh-home-paths 的优先级一致）。
 * @param {Record<string, unknown> | undefined} config
 * @returns {string}
 */
export function resolveHome(config) {
  if (typeof config?.home === 'string' && config.home.trim() !== '') return resolve(config.home.trim())
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return resolve(env.trim())
  return join(homedir(), '.dsh')
}

/**
 * 挂载插件。
 * @param {any} ctx cordis 上下文。
 * @param {Record<string, unknown>} [config] profile 里这一行的 config。
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const bin = createBin({ home: resolveHome(settings) })
  const deps = {
    ctx,
    registry: ctx.workspaceRegistry,
    bin,
    sessionsRoot: () => ctx.sessionPersistence?.root,
    logger: ctx.logger,
  }
  const runtime = createRuntime(deps)

  // 官方「删除工作区」只摘登记；这个能力**默认关闭**，配置 `trashWorkspaceFolder: true` 才监听
  // 删除事件并把工作区目录丢进系统回收站。插件自己的工作区事务始终 suppress(id)，只动会话。
  const trashWorkspaceFolder = settings.trashWorkspaceFolder === true
  const folderWatcher = trashWorkspaceFolder === false
    ? { suppress() {}, dispose() {}, idle: async () => {} }
    : createWorkspaceFolderWatcher({
        ctx,
        registry: ctx.workspaceRegistry,
        logger: ctx.logger,
        dshHome: resolveHome(settings),
        sessionsRoot: ctx.sessionPersistence?.root,
        trash: (path) => trashPathToOs(path),
      })
  ctx.effect(() => () => folderWatcher.dispose(), 'workspace-bin: OS trash watcher')

  const sessions = createSessionOps({ ...deps, runtime })
  const moves = createMoveOps({ ...deps, runtime })
  const workspaces = createWorkspaceOps({
    ...deps,
    runtime,
    restoreSession: sessions.restoreSession,
    suppressFolderTrash: (workspaceId) => folderWatcher.suppress(workspaceId),
  })
  // 路由只认一个门面：plan/move 按 payload 里有没有 sessionId 分流，restore 按 manifest.kind 分流。
  const ops = {
    survey: (payload) => (typeof payload?.sessionId === 'string' && payload.sessionId.trim() !== ''
      ? sessions.surveySession(payload)
      : workspaces.survey(payload)),
    execute: (plan) => (plan?.kind === 'session' ? sessions.executeSession(plan) : workspaces.execute(plan)),
    restore: workspaces.restore,
    purge: workspaces.purge,
    list: workspaces.list,
    recover: workspaces.recover,
    relocate: moves.relocateSession,
    recoverMoves: moves.recoverMoves,
  }

  // 一个精确路由；用 effect 包住，插件卸载时随 fiber 一起拆掉。
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createRouteHandler(ops),
    }),
    'workspace-bin: fetch route',
  )

  // 启动恢复：回收站条目只收敛不删字节；跨区移动的暂存区按「目标是否可用」补完或回滚。
  // 刻意不 await —— 激活不能被文件操作卡住。
  void ops.recover().catch((error) => {
    ctx.logger?.warn?.('workspace-bin: startup recovery failed', error)
  })
  void ops.recoverMoves().catch((error) => {
    ctx.logger?.warn?.('workspace-bin: staging recovery failed', error)
  })
}
