#!/usr/bin/env node
/**
 * 崩溃注入的子进程：在事务的某个阶段 self-SIGKILL，模拟「进程当场没了」。
 *
 * 用法：node scripts/crash-worker.mjs <scenario> <phase> <home>
 * 场景：delete-workspace / delete-session / move-session
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { makeWorld } from '../test/support/world.mjs'

const [scenario, phase, home] = process.argv.slice(2)
if (scenario === undefined || phase === undefined || home === undefined) {
  console.error('usage: crash-worker <scenario> <phase> <home>')
  process.exit(2)
}

const hooks = {
  reach(name) {
    if (name !== phase) return
    // 真·进程猝死：不跑 finally、不关句柄、不刷日志。
    process.kill(process.pid, 'SIGKILL')
  },
}

const world = await makeWorld({ home, sessionIds: ['session-1'], hooks })

try {
  if (scenario === 'delete-workspace') {
    await world.ops.execute(await world.ops.survey({ workspaceId: 'ws-1' }))
  } else if (scenario === 'delete-session') {
    await world.ops.execute(await world.ops.survey({ sessionId: 'session-1' }))
  } else if (scenario === 'move-session') {
    const targetPath = join(home, 'target')
    await mkdir(targetPath, { recursive: true })
    const target = await world.registry.create(targetPath)
    await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.id })
  } else {
    throw new Error(`unknown scenario ${scenario}`)
  }
  console.error(`crash-worker: ${scenario} completed without reaching ${phase}`)
  process.exit(1)
} catch (error) {
  console.error(`crash-worker: ${scenario} failed before ${phase}:`, error)
  process.exit(1)
}
