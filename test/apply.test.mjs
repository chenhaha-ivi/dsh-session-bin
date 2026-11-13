import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { apply, Config, inject, name, ROUTE, resolveHome } from '../src/host/index.js'
import { createFakeRegistry, makeWorld } from './support/world.mjs'

/** 与 Connection.fetch.register 的约定同形的假 ctx。 */
function fakeCtx(world, registrations, services = {}) {
  const effects = []
  return {
    effects,
    sessionPersistence: { root: world.sessionsRoot },
    workspaceRegistry: world.registry,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    get: (service) => (service === 'sessions' ? world.sessions : services[service]),
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

test('配置页的 Host 半边：读写都经 configEditor，插件不碰 profile 文件', async () => {
  const world = await makeWorld({ sessionIds: [] })
  try {
    const edits = []
    const entry = { options: { id: 'session-bin', name: 'dsh-session-bin', config: {} } }
    const editor = {
      entries: () => [entry],
      edit: async (target, change) => {
        const next = change(target.options.config, {})
        target.options.config = next
        edits.push(next)
      },
    }
    const registrations = []
    const ctx = fakeCtx(world, registrations, { configEditor: editor })
    apply(ctx, { home: world.home })
    const route = registrations[0]
    const send = (body) => route.fetch(new Request('http://localhost' + ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))

    const read = await (await send({ endpoint: 'config', payload: {} })).json()
    assert.equal(read.ok, true)
    assert.equal(read.value.available, true)
    assert.deepEqual(read.value.config, { trashWorkspaceFolder: false })
    assert.equal(read.value.home, resolveHome({}))

    const saved = await (await send({ endpoint: 'config-save', payload: { config: { trashWorkspaceFolder: true } } })).json()
    assert.equal(saved.ok, true)
    assert.equal(saved.value.saved, true)
    assert.deepEqual(edits, [{ trashWorkspaceFolder: true }])
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
    // Windows 上 resolve('/custom/home') 会带盘符，期望值也必须走 resolve。
    assert.equal(resolveHome({ home: '/custom/home' }), resolve('/custom/home'))
    assert.equal(resolveHome({}), resolve('/tmp/dsh-home-test'))
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

test('Config 校验并规范化 home / trashWorkspaceFolder', () => {
  const validate = Config['~standard'].validate
  assert.deepEqual(validate(undefined), { value: { trashWorkspaceFolder: false } })
  assert.deepEqual(validate({ trashWorkspaceFolder: true, home: ' /tmp/x ' }), {
    value: { trashWorkspaceFolder: true, home: '/tmp/x' },
  })
  const bad = validate({ trashWorkspaceFolder: 'yes', nope: 1 })
  assert.equal(Array.isArray(bad.issues), true)
  assert.equal(bad.issues.length, 2)
  assert.equal(bad.issues.some((issue) => issue.message.includes('unknown config key')), true)
  assert.equal(Array.isArray(validate('not-an-object').issues), true)
})
