/**
 * `/api/session-bin` 的请求分发。
 *
 * 一个精确路由，八种端点（含配置读写），统一信封：
 *   请求 `{ endpoint, payload }`；成功 `{ ok: true, value }`；
 *   失败 `{ ok: false, error: { code, message, details } }`。
 * 只有「请求体不是 JSON / 不是对象」回 400，其余业务失败都走 200 + 信封，
 * 客户端按 `code` 做事，不靠 HTTP 状态猜。
 *
 * @module dsh-session-bin/routes
 */

import { BinError } from './trash.js'

/** 一条 JSON 响应。 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 成功信封。 */
function ok(value) {
  return { ok: true, value }
}

/** 失败信封。 */
function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/** 一条可读的错误信息。 */
function reason(error) {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/**
 * 建请求处理器。
 *
 * @param {ReturnType<import('./workspace.js').createWorkspaceOps>} ops
 * @returns {(request: Request) => Promise<Response>}
 */
export function createRouteHandler(ops) {
  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  return async function respond(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return json(fail('session-bin/bad-request', 'the request body is not JSON'), 400)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return json(fail('session-bin/bad-request', 'the request body must be a JSON object'), 400)
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
    const payload = body.payload !== null && typeof body.payload === 'object' ? body.payload : {}
    try {
      return json(await handle(ops, endpoint, payload))
    } catch (error) {
      if (error instanceof BinError) return json(fail(error.code, error.message, error.details))
      return json(fail('session-bin/failed', reason(error)))
    }
  }
}

/**
 * 分发一个端点。
 *
 * @param {ReturnType<import('./workspace.js').createWorkspaceOps>} ops
 * @param {string} endpoint
 * @param {Record<string, unknown>} payload
 * @returns {Promise<object>}
 */
async function handle(ops, endpoint, payload) {
  if (endpoint === 'plan') {
    return ok(await ops.survey({
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      callerSessionId: payload.callerSessionId,
    }))
  }
  if (endpoint === 'move') {
    // 重新 survey 一次：确认框打开到点确认之间，工作区内容可能已经变了。
    const plan = await ops.survey({
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      callerSessionId: payload.callerSessionId,
    })
    return ok(await ops.execute(plan))
  }
  if (endpoint === 'relocate') {
    return ok(await ops.relocate({
      sessionId: payload.sessionId,
      targetWorkspaceId: payload.targetWorkspaceId,
      targetPath: payload.targetPath,
      callerSessionId: payload.callerSessionId,
    }))
  }
  if (endpoint === 'config') {
    return ok(ops.readConfig())
  }
  if (endpoint === 'config-save') {
    return ok(await ops.saveConfig(payload.config))
  }
  if (endpoint === 'list') {
    return ok(await ops.list())
  }
  if (endpoint === 'restore') {
    const entryId = typeof payload.entryId === 'string' ? payload.entryId.trim() : ''
    if (entryId === '') throw new BinError('session-bin/invalid-request', 'entryId is required')
    return ok(await ops.restore(entryId))
  }
  if (endpoint === 'empty') {
    const entryIds = Array.isArray(payload.entryIds)
      ? payload.entryIds.filter((id) => typeof id === 'string')
      : undefined
    return ok(await ops.purge(entryIds))
  }
  throw new BinError('session-bin/unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`)
}
