import assert from 'node:assert/strict'
import test from 'node:test'
import { BinError } from '../src/host/trash.js'
import { createRouteHandler } from '../src/host/routes.js'

/** 把 handler 包成「发一个 POST」。 */
function post(handler, body) {
  return handler(new Request('http://localhost/api/session-bin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
}

/** 记录调用的假 ops。 */
function fakeOps(overrides = {}) {
  const calls = []
  return {
    calls,
    survey: async (request) => {
      calls.push(['survey', request])
      return { workspace: { id: request.workspaceId }, mode: 'project', sessions: [] }
    },
    execute: async (plan) => {
      calls.push(['execute', plan])
      return { entryId: 'e-1', mode: plan.mode }
    },
    list: async () => ({ entries: [], broken: [] }),
    restore: async (entryId) => {
      calls.push(['restore', entryId])
      return { entryId }
    },
    purge: async (entryIds) => {
      calls.push(['purge', entryIds])
      return { purged: entryIds ?? ['all'], errors: [] }
    },
    relocate: async (request) => {
      calls.push(['relocate', request])
      return { sessionId: request.sessionId, applied: 'moved' }
    },
    readConfig: () => ({
      available: true,
      reason: null,
      config: { trashWorkspaceFolder: false },
      home: '/tmp/dsh-home',
    }),
    saveConfig: async (patch) => {
      calls.push(['saveConfig', patch])
      return {
        available: true,
        saved: true,
        config: { trashWorkspaceFolder: patch?.trashWorkspaceFolder === true },
        home: '/tmp/dsh-home',
      }
    },
    ...overrides,
  }
}

test('plan 只做调查，不执行', async () => {
  const ops = fakeOps()
  const response = await post(createRouteHandler(ops), { endpoint: 'plan', payload: { workspaceId: 'ws-1', callerSessionId: 's-9' } })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(ops.calls, [['survey', { workspaceId: 'ws-1', sessionId: undefined, callerSessionId: 's-9' }]])
})

test('move 先重新 survey 再执行', async () => {
  const ops = fakeOps()
  const body = await (await post(createRouteHandler(ops), { endpoint: 'move', payload: { workspaceId: 'ws-1' } })).json()
  assert.equal(body.ok, true)
  assert.deepEqual(ops.calls.map((call) => call[0]), ['survey', 'execute'])
  assert.equal(body.value.entryId, 'e-1')
})

test('list / restore / empty 的分发', async () => {
  const ops = fakeOps()
  const handler = createRouteHandler(ops)
  const listed = await (await post(handler, { endpoint: 'list' })).json()
  assert.deepEqual(listed.value, { entries: [], broken: [] })

  const restored = await (await post(handler, { endpoint: 'restore', payload: { entryId: 'e-7' } })).json()
  assert.equal(restored.value.entryId, 'e-7')

  const emptied = await (await post(handler, { endpoint: 'empty', payload: { entryIds: ['e-1', 42, 'e-2'] } })).json()
  assert.deepEqual(emptied.value.purged, ['e-1', 'e-2'])
  assert.deepEqual(ops.calls.at(-1), ['purge', ['e-1', 'e-2']])
})

test('relocate 透传会话与目标', async () => {
  const ops = fakeOps()
  const body = await (await post(createRouteHandler(ops), {
    endpoint: 'relocate',
    payload: { sessionId: 's-1', targetWorkspaceId: 'ws-2', callerSessionId: 's-9' },
  })).json()
  assert.equal(body.ok, true)
  assert.deepEqual(ops.calls.at(-1), ['relocate', { sessionId: 's-1', targetWorkspaceId: 'ws-2', targetPath: undefined, callerSessionId: 's-9' }])
  assert.equal(body.value.applied, 'moved')
})

test('empty 不带 entryIds 时清空全部', async () => {
  const ops = fakeOps()
  const body = await (await post(createRouteHandler(ops), { endpoint: 'empty' })).json()
  assert.deepEqual(ops.calls.at(-1), ['purge', undefined])
  assert.deepEqual(body.value.purged, ['all'])
})

test('restore 缺 entryId 是稳定错误码', async () => {
  const ops = fakeOps()
  const body = await (await post(createRouteHandler(ops), { endpoint: 'restore', payload: {} })).json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'session-bin/invalid-request')
})

test('未知端点 / 坏请求体', async () => {
  const ops = fakeOps()
  const handler = createRouteHandler(ops)

  const unknown = await (await post(handler, { endpoint: 'selfdestruct' })).json()
  assert.equal(unknown.error.code, 'session-bin/unknown-endpoint')

  const broken = await post(handler, '{oops')
  assert.equal(broken.status, 400)
  assert.equal((await broken.json()).error.code, 'session-bin/bad-request')

  const notObject = await post(handler, [1, 2, 3])
  assert.equal(notObject.status, 400)
})

test('BinError 走信封，未知异常折叠成 failed', async () => {
  const ops = fakeOps({
    survey: async () => {
      throw new BinError('session-bin/unknown-workspace', 'nope', { workspaceId: 'x' })
    },
  })
  const first = await (await post(createRouteHandler(ops), { endpoint: 'plan', payload: { workspaceId: 'x' } })).json()
  assert.deepEqual(first, {
    ok: false,
    error: { code: 'session-bin/unknown-workspace', message: 'nope', details: { workspaceId: 'x' } },
  })

  const second = await (await post(createRouteHandler(fakeOps({
    list: async () => {
      throw new Error('boom')
    },
  })), { endpoint: 'list' })).json()
  assert.equal(second.error.code, 'session-bin/failed')
  assert.equal(second.error.message, 'boom')
})

test('config 端点只读当前配置', async () => {
  const ops = fakeOps()
  const body = await (await post(createRouteHandler(ops), { endpoint: 'config', payload: {} })).json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.value, {
    available: true,
    reason: null,
    config: { trashWorkspaceFolder: false },
    home: '/tmp/dsh-home',
  })
  assert.deepEqual(ops.calls, [])
})

test('config-save 把 payload.config 原样交给门面，拒绝走信封', async () => {
  const ops = fakeOps()
  const body = await (await post(createRouteHandler(ops), {
    endpoint: 'config-save',
    payload: { config: { trashWorkspaceFolder: true } },
  })).json()
  assert.equal(body.ok, true)
  assert.equal(body.value.saved, true)
  assert.deepEqual(body.value.config, { trashWorkspaceFolder: true })
  assert.deepEqual(ops.calls, [['saveConfig', { trashWorkspaceFolder: true }]])

  const refused = fakeOps({
    saveConfig: async () => {
      throw new BinError('session-bin/invalid-config', 'unknown config key: nope')
    },
  })
  const failure = await (await post(createRouteHandler(refused), {
    endpoint: 'config-save',
    payload: { config: { nope: 1 } },
  })).json()
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, 'session-bin/invalid-config')
})
