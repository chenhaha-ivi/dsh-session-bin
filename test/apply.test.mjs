import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { apply, inject, name, ROUTE, resolveHome } from '../src/host/index.js'
import { createFakeRegistry, makeWorld } from './support/world.mjs'

/** 与 Connection.fetch.register 的约定同形的假 ctx。 */
function fakeCtx(world, registrations) {
  const effects = []
  return {
    effects,
    sessionPersistence: { root: world.sessionsRoot },
    workspaceRegistry: world.registry,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: (service) => (service === 'sessions' ? world.sessions : undefined),
    on(name) {
      this.listeners.push(name)
      return () => {}
    },
    listeners: [],
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
      return disposer
    },
    connection: {
      fetch: {
        register(route) {
          registrations.push(route)
          return () => {}
        },
      },
    },
  }
}

test('apply 挂一个精确 POST 路由，并注册可拆的 effect', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const registrations = []
    const ctx = fakeCtx(world, registrations)
    apply(ctx, { home: world.home })

    assert.equal(registrations.length, 1)
    const route = registrations[0]
    assert.equal(route.path, ROUTE)
    assert.equal(ROUTE, '/api/session-bin')
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')

    // 路由真的能穿过 apply 的接线驱动一次 plan。
    const response = await route.fetch(new Request('http://localhost' + ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'plan', payload: { workspaceId: 'ws-1' } }),
    }))
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.value.mode, 'project')

    // 同一个路由也能驱动单会话删除：payload 带 sessionId 就转发到会话事务。
    const sessionPlan = await (await route.fetch(new Request('http://localhost' + ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'plan', payload: { sessionId: 'session-1' } }),
    }))).json()
    assert.equal(sessionPlan.ok, true)
    assert.equal(sessionPlan.value.kind, 'session')

    const movedSession = await (await route.fetch(new Request('http://localhost' + ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'move', payload: { sessionId: 'session-1' } }),
    }))).json()
    assert.equal(movedSession.ok, true)
    assert.equal(world.registry.get('ws-1').sessionIds.length, 0)

    // 启动恢复是非阻塞的；等一拍再断言它没有留下 unresolved。
    await new Promise((settle) => setTimeout(settle, 20))
    assert.equal(ctx.effects.length, 2)
    assert.deepEqual(ctx.effects.map((effect) => effect.label), [
      'session-bin: OS trash watcher',
      'session-bin: fetch route',
    ])
  } finally {
    const { dispose } = await import('./helpers.mjs')
    await dispose(world.home)
  }
})

test('trashWorkspaceFolder 默认关闭；显式 true 才监听官方删除', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const offCtx = fakeCtx(world, [])
    apply(offCtx, { home: world.home })
    assert.deepEqual(offCtx.listeners, [], '默认不挂 domain/changed')

    const onCtx = fakeCtx(world, [])
    apply(onCtx, { home: world.home, trashWorkspaceFolder: true })
    assert.deepEqual(onCtx.listeners, ['domain/changed'], '显式开启才监听')
  } finally {
    const { dispose } = await import('./helpers.mjs')
    await dispose(world.home)
  }
})

test('resolveHome：配置 > DSH_HOME > ~/.dsh', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-test'
    assert.equal(resolveHome({ home: '/custom/home' }), '/custom/home')
    assert.equal(resolveHome({}), '/tmp/dsh-home-test')
    process.env.DSH_HOME = ''
    assert.equal(resolveHome(undefined).endsWith(join('.dsh')), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('插件导出面稳定', () => {
  assert.equal(name, 'dsh-session-bin')
  assert.deepEqual(inject, ['connection', 'sessionPersistence', 'workspaceRegistry'])
  assert.equal(typeof apply, 'function')
})
