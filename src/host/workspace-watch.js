/**
 * 监听官方「删除工作区」，把工作区的本地目录也丢进系统回收站。
 *
 * 官方的删除只摘登记、保留文件夹；这里只订阅 Host 的 `domain/changed`，
 * 在 `operation: 'deleted'` 时按缓存的路径动手。要点：
 *   - 事件只给 workspace id，所以 upsert 时缓存 path；
 *   - 插件自己删工作区（回收站事务）会 `suppress(id)`，绝不把文件夹也搬走；
 *   - 路径是 DSH home、sessions 根、当前进程 cwd、或别的嵌套工作区的祖先时，
 *     一律跳过并记日志，宁可少删不可误删。
 *
 * @module dsh-session-bin/workspace-watch
 */

import { appendFile, lstat, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { TRASH_ROOT_NAME } from './trash.js'

/** `child` 是否就是 `parent` 或在它里面。 */
function isInside(parent, child) {
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(base)
}

/**
 * @param {object} options
 * @param {any} options.ctx cordis 上下文（订阅 `domain/changed`）。
 * @param {any} options.registry `workspaceRegistry`（启动时读一遍现存的）。
 * @param {{warn?: Function, info?: Function}} [options.logger]
 * @param {(path: string) => Promise<{via: string, target: string}>} options.trash 移进系统回收站。
 * @param {string} [options.home] 用户主目录（保护路径 / 测试注入）。
 * @param {string} [options.dshHome] DSH home（保护路径）。
 * @param {string} [options.sessionsRoot] 会话存储根（保护路径）。
 * @param {string} [options.cwd] 当前进程 cwd（保护路径 / 测试注入）。
 * @param {string} [options.logPath] 搬移日志路径；缺省是 `<dshHome>/session-bin/os-trash.log`。
 * @returns {{suppress: (id: string) => void, dispose: () => void, idle: () => Promise<void>, known: Map<string, object>}}
 */
export function createWorkspaceFolderWatcher(options) {
  const { ctx, registry, logger, trash, home = homedir() } = options
  const dshHome = typeof options.dshHome === 'string' && options.dshHome !== '' ? resolve(options.dshHome) : undefined
  const sessionsRoot = typeof options.sessionsRoot === 'string' && options.sessionsRoot !== '' ? resolve(options.sessionsRoot) : undefined
  const cwd = resolve(options.cwd ?? process.cwd())
  const logPath = options.logPath ?? (dshHome === undefined ? undefined : join(dshHome, TRASH_ROOT_NAME, 'os-trash.log'))

  /** workspaceId → { path, title }；删除事件只有 id，全靠这份缓存。 */
  const known = new Map()
  /** 插件自己触发的删除：只摘登记、不搬文件夹。 */
  const suppressed = new Set()
  /** 正在跑的搬移（测试要等它们落地）。 */
  const pending = new Set()

  const log = (level, message) => {
    try {
      logger?.[level]?.(`session-bin: ${message}`)
    } catch {
      // 日志失败不影响删除。
    }
  }

  /**
   * 把一次搬移的结果写进可读的日志文件（`~/.dsh/session-bin/os-trash.log`）。
   * 主机日志在打包后的应用里看不到，这一步是唯一能让用户/维护者事后对账的线索。
   * @param {string} line
   */
  async function writeLog(line) {
    if (logPath === undefined) return
    try {
      await mkdir(dirname(logPath), { recursive: true })
      await appendFile(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch {
      // 日志写不进去不影响删除本身。
    }
  }

  const remember = (id, value) => {
    if (value === null || typeof value !== 'object') return
    if (typeof value.path !== 'string' || value.path === '') return
    known.set(String(id), {
      path: value.path,
      title: typeof value.title === 'string' ? value.title : '',
    })
  }

  for (const workspace of registry?.list?.() ?? []) {
    remember(workspace?.id, { path: workspace?.path, title: workspace?.title })
  }

  /** 该路径是不是「碰一下就出事」的地方。 */
  function refusalFor(target, deletedId) {
    if (target === sep || target === '') return 'the filesystem root'
    for (const protectedPath of [resolve(home), dshHome, sessionsRoot, cwd]) {
      if (protectedPath === undefined) continue
      if (target === protectedPath) return `a protected path (${protectedPath})`
    }
    if (dshHome !== undefined && isInside(target, dshHome)) return 'an ancestor of the DSH home'
    if (isInside(target, cwd)) return 'an ancestor of the host process cwd'
    for (const [otherId, other] of known) {
      if (otherId === deletedId) continue
      if (isInside(target, resolve(other.path))) return `an ancestor of workspace ${JSON.stringify(other.path)}`
    }
    return null
  }

  async function handleDeletion(id, record) {
    const target = resolve(record.path)
    const refusal = refusalFor(target, id)
    if (refusal !== null) {
      log('warn', `not moving workspace ${JSON.stringify(record.title || id)} to the OS trash: the folder is ${refusal}`)
      void writeLog(`skipped id=${JSON.stringify(id)} title=${JSON.stringify(record.title)} path=${JSON.stringify(target)} reason=${JSON.stringify(refusal)}`)
      return
    }
    try {
      const info = await lstat(target)
      if (info === undefined) return
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        log('info', `workspace ${JSON.stringify(record.title || id)} was removed; its folder is already gone`)
        return
      }
      log('warn', `cannot inspect ${JSON.stringify(target)} before moving it to the OS trash: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    try {
      const result = await trash(target)
      log('info', `workspace ${JSON.stringify(record.title || id)} moved to the OS trash via ${result?.via ?? 'unknown'}: ${result?.target ?? target}`)
      await writeLog(`moved id=${JSON.stringify(id)} title=${JSON.stringify(record.title)} path=${JSON.stringify(target)} via=${JSON.stringify(result?.via)} target=${JSON.stringify(result?.target ?? target)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `moving workspace ${JSON.stringify(record.title || id)} (${target}) to the OS trash failed: ${message}`)
      await writeLog(`failed id=${JSON.stringify(id)} title=${JSON.stringify(record.title)} path=${JSON.stringify(target)} error=${JSON.stringify(message)}`)
    }
  }

  const onChange = (change) => {
    if (change === null || typeof change !== 'object') return
    if (change.domain !== 'workspace' || change.table !== 'workspaces') return
    const id = String(change.key)
    if (change.operation === 'deleted') {
      const record = known.get(id)
      known.delete(id)
      if (record === undefined) {
        log('warn', `workspace ${id} was deleted but the watcher had no cached path; its folder was left alone`)
        void writeLog(`skipped id=${JSON.stringify(id)} reason="no cached path"`)
        return
      }
      if (suppressed.has(id)) {
        log('info', `workspace ${id} was deleted by the plugin itself; its folder stays on disk`)
        void writeLog(`skipped id=${JSON.stringify(id)} path=${JSON.stringify(record.path)} reason="plugin-internal delete"`)
        return
      }
      const job = handleDeletion(id, record).catch(() => {})
      pending.add(job)
      void job.finally(() => pending.delete(job))
      return
    }
    // 存储域用的是 `put`；老代码/测试里的 `upsert` 也认，避免版本差异漏缓存。
    if (change.operation === 'put' || change.operation === 'upsert') remember(id, change.value)
  }

  const dispose = typeof ctx?.on === 'function' ? ctx.on('domain/changed', onChange) : undefined

  return {
    known,
    suppress(id) { suppressed.add(String(id)) },
    dispose() { if (typeof dispose === 'function') dispose() },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending])
    },
  }
}
