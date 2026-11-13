import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createWorkspaceFolderWatcher } from '../src/host/workspace-watch.js'
import { dispose, tempHome } from './helpers.mjs'

/** 最小的 cordis 事件总线。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, fn) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
    emit(name, payload) {
      listeners.get(name)?.(payload)
    },
  }
}

function silentLogger() {
  const lines = []
  return { lines, warn: (message) => lines.push(message), info: (message) => lines.push(message) }
}

async function makeWatcher(options = {}) {
  const home = options.home ?? await tempHome('watch-')
  const dshHome = join(home, '.dsh')
  await mkdir(dshHome, { recursive: true })
  const workspace = options.workspace ?? join(home, 'project')
  await mkdir(workspace, { recursive: true })
  const registry = { list: () => options.workspaces ?? [{ id: 'ws-1', path: workspace, title: 'demo' }] }
  const ctx = fakeCtx()
  const logger = silentLogger()
  const trashed = []
  const watcher = createWorkspaceFolderWatcher({
    ctx,
    registry,
    logger,
    home,
    dshHome,
    cwd: home,
    sessionsRoot: join(home, 'sessions'),
    trash: options.trash ?? (async (path) => { trashed.push(path); return { via: 'test', target: path } }),
  })
  return { home, dshHome, workspace, ctx, logger, trashed, watcher }
}

test('官方删除工作区 -> 把本地目录丢进系统回收站', async () => {
  const world = await makeWatcher()
  try {
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-1' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [world.workspace])
  } finally {
    await dispose(world.home)
  }
})

test('每次搬移都写一份可读日志', async () => {
  const world = await makeWatcher()
  try {
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-1' })
    await world.watcher.idle()
    const log = await readFile(join(world.dshHome, 'workspace-bin', 'os-trash.log'), 'utf8')
    assert.equal(log.includes('moved'), true)
    assert.equal(log.includes(world.workspace), true)
  } finally {
    await dispose(world.home)
  }
})

test('插件自己的删除被 suppress：目录不动', async () => {
  const world = await makeWatcher()
  try {
    world.watcher.suppress('ws-1')
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-1' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [])
  } finally {
    await dispose(world.home)
  }
})

test('put 会缓存新建工作区的路径', async () => {
  const world = await makeWatcher()
  try {
    const created = join(world.home, 'created')
    await mkdir(created, { recursive: true })
    world.ctx.emit('domain/changed', {
      domain: 'workspace',
      table: 'workspaces',
      operation: 'put',
      key: 'ws-2',
      value: { id: 'ws-2', path: created, title: 'created', sessionIds: [] },
    })
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-2' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [created])
  } finally {
    await dispose(world.home)
  }
})

test('父目录里还有别的嵌套工作区时拒绝搬', async () => {
  const home = await tempHome('watch-')
  try {
    const parent = join(home, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    const world = await makeWatcher({
      home,
      workspaces: [
        { id: 'ws-parent', path: parent, title: 'parent' },
        { id: 'ws-child', path: child, title: 'child' },
      ],
    })
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-parent' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [])
    assert.equal(world.logger.lines.some((line) => line.includes('ancestor')), true)
  } finally {
    await dispose(home)
  }
})

test('DSH home 被当作保护区，绝不搬', async () => {
  const home = await tempHome('watch-')
  try {
    const world = await makeWatcher({
      home,
      workspaces: [{ id: 'ws-dsh', path: join(home, '.dsh'), title: 'dsh' }],
    })
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-dsh' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [])
  } finally {
    await dispose(home)
  }
})

test('没缓存到路径 / 目录已经不存在时安静跳过', async () => {
  const world = await makeWatcher()
  try {
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'unknown' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [])
    const gone = join(world.home, 'gone')
    // 缓存里没有它，直接构造 upsert 再删
    world.ctx.emit('domain/changed', {
      domain: 'workspace', table: 'workspaces', operation: 'put', key: 'ws-gone',
      value: { id: 'ws-gone', path: gone, title: 'gone', sessionIds: [] },
    })
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-gone' })
    await world.watcher.idle()
    assert.deepEqual(world.trashed, [])
  } finally {
    await dispose(world.home)
  }
})

test('搬失败只记日志，不抛', async () => {
  const world = await makeWatcher({
    trash: async () => { throw new Error('trash is full') },
  })
  try {
    world.ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', operation: 'deleted', key: 'ws-1' })
    await world.watcher.idle()
    assert.equal(world.logger.lines.some((line) => line.includes('trash is full')), true)
  } finally {
    await dispose(world.home)
  }
})
