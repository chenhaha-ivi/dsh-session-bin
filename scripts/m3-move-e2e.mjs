#!/usr/bin/env node
/**
 * M3-2 端到端（进程内）：跨区移动 + 启动恢复。
 * 跑法：node scripts/m3-move-e2e.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { projectKey } from '../src/host/paths.js'
import { createRouteHandler } from '../src/host/routes.js'
import { dispose } from '../test/helpers.mjs'
import { makeWorld } from '../test/support/world.mjs'

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

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const world = await makeWorld({ sessionIds: ['session-1'] })
const handler = createRouteHandler(world.ops)
let step = 0
const say = (message) => console.log(`${String(++step).padStart(2, '0')}  ${message}`)

try {
  const targetPath = join(world.home, 'target-ws')
  await mkdir(targetPath, { recursive: true })
  const target = await world.registry.create(targetPath)
  // 预置一条投影缓存：跨区移动应保留它、只把 identity.cwd 指向新目录（删了会让冷列表显示未命名）。
  world.cacheRows.set('session-1', {
    identity: { formatVersion: 4, createdAt: 1, cwd: world.workspacePath, isSeeded: false },
    rows: { title: { ver: 1, seq: 1, val: 'hello' } },
  })

  say('relocate：把会话搬到目标工作区')
  const moved = await call(handler, 'relocate', { sessionId: 'session-1', targetWorkspaceId: target.id })
  assert.equal(moved.applied, 'moved')
  assert.equal(moved.events, 2)
  assert.equal(await exists(join(world.projectDir, 'session-1')), false)
  assert.equal(await exists(join(world.sessionsRoot, projectKey(targetPath), 'session-1')), true)

  say('校验：header cwd、归属、投影缓存')
  assert.equal(world.persistence.headers.get('session-1').cwd, targetPath)
  assert.deepEqual(target.sessionIds, ['session-1'])
  assert.deepEqual(world.deletedCacheRows, [], '缓存不能被删，否则冷列表会显示未命名')
  assert.equal(world.cacheRows.get('session-1').identity.cwd, targetPath)
  assert.deepEqual(await world.moveOps.recoverMoves(), { recovered: [], unresolved: [], errors: [] })

  say('收尾：清理测试目录')
  await dispose(world.home)
  console.log('\nM3-2 move e2e: OK')
} catch (error) {
  await dispose(world.home)
  console.error('\nM3-2 move e2e: FAILED')
  throw error
}
