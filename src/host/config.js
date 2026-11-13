/**
 * 插件自身配置的读写（可视化配置页的 Host 半边）。
 *
 * 只通过 `configEditor` 服务动 profile 层：读走 `editor.entries()`，写走
 * `editor.edit()`——由 DSH 校验、序列化并热重载，插件**不自己**解析或改写
 * `cordis.patch.yml`。拿不到 `configEditor`（或这一行不在 profile 里）时
 * 明确报 `available: false`，让客户端把「去改 YAML」的说明显示出来。
 *
 * @module dsh-session-bin/config
 */

import { BinError } from './trash.js'

/** bundle patch 里这一行的 id（`cordis.patch.yml` 的 `- id: session-bin`）。 */
export const ENTRY_ID = 'session-bin'

/** 插件包名（`id` 被改过时用它兜底）。 */
export const MODULE_NAME = 'dsh-session-bin'

/** 界面允许写的配置键：其余键一律拒绝，拼错的键不该落进 profile。 */
const WRITABLE_KEYS = new Set(['trashWorkspaceFolder', 'home'])

/** 一条可读的错误信息。 */
function reason(error) {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** 只保留插件认识的配置键，并把它们规范化成激活时的形状。 */
function normalize(raw) {
  const settings = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { trashWorkspaceFolder: settings.trashWorkspaceFolder === true }
  if (typeof settings.home === 'string' && settings.home.trim() !== '') config.home = settings.home.trim()
  return config
}

/**
 * 建配置读写门面。
 *
 * @param {object} deps
 * @param {any} deps.ctx cordis 上下文（只用 `get('configEditor')`，服务晚到也没关系）。
 * @param {(value: unknown) => {value: Record<string, unknown>} | {issues: Array<{message: string}>}} deps.validate
 *   插件的 `Config` 校验函数。
 * @param {(config: Record<string, unknown>) => string} deps.resolveHome 解析有效 DSH home。
 * @returns {{read: () => object, save: (patch: unknown) => Promise<object>}}
 */
export function createConfigOps(deps) {
  const { ctx, validate, resolveHome } = deps

  /** configEditor 服务；profile 没挂就返回 undefined。 */
  function editor() {
    const service = ctx?.get?.('configEditor')
    if (service === undefined || service === null) return undefined
    if (typeof service.entries !== 'function' || typeof service.edit !== 'function') return undefined
    return service
  }

  /** 找到本插件在 profile 里那一行（先认 id，再认包名）。 */
  function findEntry(service) {
    const entries = service.entries()
    const list = Array.isArray(entries) ? entries : []
    return list.find((entry) => entry?.options?.id === ENTRY_ID)
      ?? list.find((entry) => entry?.options?.name === MODULE_NAME)
  }

  /** 这一行的当前有效配置（未设置就是默认值）。 */
  function currentOf(entry) {
    return normalize(entry?.options?.config)
  }

  /**
   * 读当前配置；`available: false` 时客户端只显示说明，不给表单。
   * @returns {{
   *   available: boolean,
   *   reason: 'no-editor' | 'no-entry' | null,
   *   config: Record<string, unknown> | null,
   *   home: string | null,
   * }}
   */
  function read() {
    const service = editor()
    if (service === undefined) return { available: false, reason: 'no-editor', config: null, home: null }
    const entry = findEntry(service)
    if (entry === undefined) return { available: false, reason: 'no-entry', config: null, home: null }
    const config = currentOf(entry)
    return { available: true, reason: null, config, home: resolveHome(config) }
  }

  /**
   * 保存改动：合并当前配置 → 用插件的 Config schema 校验 → 交给 configEditor。
   *
   * 只接受 `trashWorkspaceFolder`（布尔）与 `home`（字符串或 null 表示清空），
   * 未知键直接拒绝：界面不该能把拼错的键写进 profile。
   *
   * @param {unknown} patch 客户端提交的改动。
   * @returns {Promise<{available: true, config: Record<string, unknown>, home: string, saved: true}>}
   */
  async function save(patch) {
    const service = editor()
    if (service === undefined) {
      throw new BinError('session-bin/no-config-editor', 'this profile has no config editor; edit cordis.patch.yml instead')
    }
    const entry = findEntry(service)
    if (entry === undefined) {
      throw new BinError('session-bin/no-config-entry', 'the session-bin row is not addressable in this profile')
    }
    const raw = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
    for (const key of Object.keys(raw)) {
      if (!WRITABLE_KEYS.has(key)) {
        throw new BinError('session-bin/invalid-config', `unknown config key: ${key}`)
      }
    }
    const next = { ...currentOf(entry) }
    if (Object.hasOwn(raw, 'trashWorkspaceFolder')) {
      if (typeof raw.trashWorkspaceFolder !== 'boolean') {
        throw new BinError('session-bin/invalid-config', 'trashWorkspaceFolder must be a boolean')
      }
      next.trashWorkspaceFolder = raw.trashWorkspaceFolder
    }
    if (Object.hasOwn(raw, 'home')) {
      if (raw.home === null) delete next.home
      else if (typeof raw.home !== 'string') throw new BinError('session-bin/invalid-config', 'home must be a string')
      else if (raw.home.trim() === '') delete next.home
      else next.home = raw.home.trim()
    }
    const checked = validate(next)
    if (Array.isArray(checked?.issues) && checked.issues.length > 0) {
      throw new BinError('session-bin/invalid-config', checked.issues.map((issue) => issue.message).join('; '))
    }
    const candidate = checked?.value !== null && typeof checked?.value === 'object' ? checked.value : next
    try {
      await service.edit(entry, () => candidate)
    } catch (error) {
      throw new BinError('session-bin/config-write-failed', reason(error))
    }
    return { available: true, config: normalize(candidate), home: resolveHome(candidate), saved: true }
  }

  return { read, save }
}
