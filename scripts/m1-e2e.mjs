#!/usr/bin/env node
/**
 * M1 端到端（进程内）：真文件系统 + 真回收站 + 真事务 + 真路由信封，
 * 只把 DSH 的注册表 / sessions 换成假实现（真宿主启动属于 M4 真机验收）。
 *
 * 跑法：node scripts/m1-e2e.mjs
 * 数据全在 .test-tmp/ 下，结束自动清理。
 */
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRouteHandler } from '../src/host/routes.js'
import { dispose } from '../test/helpers.mjs'
import { makeWorld } from '../test/support/world.mjs'

/** 发一个端点调用。 */
async function call(handler, endpoint, payload) {
  const response = await handler(new Request('http://localhost/api/session-bin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true, `endpoint ${endpoint} failed: ${JSON.stringify(body.error)}`)
  return body.value
}

/** 路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const world = await makeWorld({ sessionIds: ['session-1', 'session-2'] })
const handler = createRouteHandler(world.ops)
let step = 0
const say = (message) => console.log(`${String(++step).padStart(2, '0')}  ${message}`)

try {
  say('plan：确认整目录模式与会话数')
  const plan = await call(handler, 'plan', { workspaceId: 'ws-1' })
  assert.equal(plan.mode, 'project')
  assert.equal(plan.sessionCount, 2)

  say('move：删进回收站')
  const moved = await call(handler, 'move', { workspaceId: 'ws-1' })
  assert.equal(moved.mode, 'project')
  assert.equal(world.registry.get('ws-1'), undefined)
  assert.equal(await exists(world.projectDir), false)

  say('list：回收站里有一个 done 条目')
  const listing = await call(handler, 'list', {})
  assert.equal(listing.entries.length, 1)
  assert.equal(listing.entries[0].state, 'done')
  assert.equal(listing.entries[0].kind, 'workspace')
  assert.equal(listing.entries[0].sessionCount, 2)

  say('restore：恢复回原路径并重新登记')
  const restored = await call(handler, 'restore', { entryId: moved.entryId })
  assert.equal(restored.workspaceRestored, true)
  assert.equal(await exists(join(world.projectDir, 'session-1')), true)
  assert.notEqual(await world.registry.resolveByPath(world.workspacePath), undefined)

  say('再删一次，然后 empty：永久删除')
  const again = await call(handler, 'move', { workspaceId: (await world.registry.resolveByPath(world.workspacePath)).id })
  const emptied = await call(handler, 'empty', { entryIds: [again.entryId] })
  assert.deepEqual(emptied.purged, [again.entryId])
  assert.equal((await call(handler, 'list', {})).entries.length, 0)

  say('收尾：真实 ~/.dsh 零改动，测试目录清理')
  await dispose(world.home)
  console.log('\nM1 e2e: OK')
} catch (error) {
  await dispose(world.home)
  console.error('\nM1 e2e: FAILED')
  throw error
}
