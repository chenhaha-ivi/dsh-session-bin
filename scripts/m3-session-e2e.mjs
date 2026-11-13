#!/usr/bin/env node
/**
 * M3-1 端到端（进程内）：单会话删除 → 列表 → 恢复，真文件系统 + 真路由信封。
 * 跑法：node scripts/m3-session-e2e.mjs
 */
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRouteHandler } from '../src/host/routes.js'
import { dispose } from '../test/helpers.mjs'
import { makeWorld } from '../test/support/world.mjs'

async function call(handler, endpoint, payload) {
  const response = await handler(new Request('http://localhost/api/workspace-bin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true, `endpoint ${endpoint} failed: ${JSON.stringify(body.error)}`)
  return body.value
}

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
  say('plan(sessionId)：确认会话与归属')
  const plan = await call(handler, 'plan', { sessionId: 'session-1' })
  assert.equal(plan.kind, 'session')
  assert.equal(plan.workspace.id, 'ws-1')

  say('move(sessionId)：单会话进回收站')
  const moved = await call(handler, 'move', { sessionId: 'session-1' })
  assert.equal(await exists(join(world.projectDir, 'session-1')), false)
  assert.equal(await exists(join(world.projectDir, 'session-2')), true)
  assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-2'])

  say('list：条目 kind=session')
  const listing = await call(handler, 'list', {})
  assert.equal(listing.entries.length, 1)
  assert.equal(listing.entries[0].kind, 'session')
  assert.equal(listing.entries[0].state, 'done')

  say('restore：会话回位并重新挂回工作区')
  const restored = await call(handler, 'restore', { entryId: moved.entryId })
  assert.equal(restored.kind, 'session')
  assert.equal(await exists(join(world.projectDir, 'session-1')), true)
  assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-1', 'session-2'])
  assert.equal((await call(handler, 'list', {})).entries.length, 0)

  say('收尾：清理测试目录')
  await dispose(world.home)
  console.log('\nM3-1 session e2e: OK')
} catch (error) {
  await dispose(world.home)
  console.error('\nM3-1 session e2e: FAILED')
  throw error
}
