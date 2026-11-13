#!/usr/bin/env node
/**
 * M4-1 崩溃注入：让子进程在事务的每个关键阶段被 SIGKILL，再用启动恢复收敛，
 * 断言「文件、归属、回收站」三者最终一致且没有数据副本丢失。
 *
 * 跑法：node scripts/crash-injection.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createBin } from '../src/host/trash.js'
import { dispose, tempHome } from '../test/helpers.mjs'
import { makeWorld } from '../test/support/world.mjs'

const WORKER = new URL('./crash-worker.mjs', import.meta.url).pathname

/** 路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 跑子进程直到它自己崩掉；返回退出信息。 */
function runWorker(scenario, phase, home) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [WORKER, scenario, phase, home], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('exit', (code, signal) => settle({ code, signal, stderr }))
  })
}

/** 用磁盘上留下来的世界重建一个可恢复的上下文。 */
async function recoveryWorld(home) {
  return await makeWorld({
    home,
    sessionIds: [],
    seedSessions: false,
    loadFromDisk: true,
    workspaces: [
      { id: 'ws-1', path: join(home, 'ws'), title: 'demo', sessionIds: [] },
      { id: 'ws-2', path: join(home, 'target'), title: 'target', sessionIds: [] },
    ],
  })
}

/** 一个会话的字节副本现在落在哪（源 / 目标 / 暂存区），用于断言「恰好一份」。 */
async function copiesOf(world) {
  const found = []
  for (const entry of await readdir(world.sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const dir = join(world.sessionsRoot, entry.name, 'session-1')
    if (await exists(dir)) found.push(dir === join(world.projectDir, 'session-1') ? 'source' : `sessions/${entry.name}`)
  }
  try {
    for (const op of await readdir(join(world.sessionsRoot, '_session-bin-staging'))) {
      if (await exists(join(world.sessionsRoot, '_session-bin-staging', op, 'session-1'))) found.push(`staging/${op}`)
    }
  } catch {
    // 没有暂存区
  }
  return found
}

/** 一个场景：崩 → 恢复 → 断言。 */
async function scenario(name, expect) {
  const home = await tempHome('crash-')
  try {
    const result = await runWorker(name.scenario, name.phase, home)
    assert.equal(result.signal, 'SIGKILL', `${name.scenario}@${name.phase}: worker did not die as planned\n${result.stderr}`)

    const world = await recoveryWorld(home)
    const bin = createBin({ home })
    const before = await bin.scan()

    if (name.scenario === 'move-session') {
      await world.ops.recoverMoves()
    } else {
      await world.ops.recover()
    }

    const after = await bin.scan()
    await expect({ world, bin, before, after, home })
    console.log(`ok  ${name.scenario}@${name.phase}`)
  } finally {
    await dispose(home)
  }
}

const scenarios = [
  {
    scenario: 'delete-workspace',
    phase: 'after-plan',
    async expect({ world, before, after }) {
      assert.equal(before.entries.length, 1)
      assert.equal(before.entries[0].manifest.state, 'planned')
      assert.equal(after.entries.length, 0, '什么都没搬：恢复应丢弃空条目')
      assert.equal(await exists(join(world.projectDir, 'session-1')), true)
      assert.notEqual(world.registry.get('ws-1'), undefined)
    },
  },
  {
    scenario: 'delete-workspace',
    phase: 'after-move',
    async expect({ world, after }) {
      assert.equal(after.entries.length, 1)
      assert.equal(after.entries[0].manifest.state, 'done', '已进回收站：恢复应补完删除')
      assert.equal(await exists(world.projectDir), false)
      assert.equal(world.registry.get('ws-1'), undefined)
      assert.equal(await exists(join(world.bin.sessionsDir(after.entries[0].id), after.entries[0].manifest.projectKey, 'session-1')), true)
    },
  },
  {
    scenario: 'delete-workspace',
    phase: 'after-registry',
    async expect({ world, after }) {
      assert.equal(after.entries.length, 1)
      assert.equal(after.entries[0].manifest.state, 'done')
      assert.equal(world.registry.get('ws-1'), undefined)
    },
  },
  {
    scenario: 'delete-session',
    phase: 'after-move',
    async expect({ world, after }) {
      assert.equal(after.entries.length, 1)
      assert.equal(after.entries[0].manifest.kind, 'session')
      assert.equal(after.entries[0].manifest.state, 'done')
      assert.equal(await exists(join(world.projectDir, 'session-1')), false)
    },
  },
  {
    scenario: 'move-session',
    phase: 'after-park',
    async expect({ world, after }) {
      assert.deepEqual(after.entries, [])
      assert.equal(await exists(join(world.projectDir, 'session-1')), true, '没有后继：必须回滚回源目录')
      assert.deepEqual(await copiesOf(world), ['source'])
      const staging = await readdir(join(world.sessionsRoot, '_session-bin-staging')).catch(() => [])
      assert.deepEqual(staging, [])
    },
  },
  {
    scenario: 'move-session',
    phase: 'after-flush',
    async expect({ world }) {
      const copies = await copiesOf(world)
      assert.equal(copies.length, 1, `must end with exactly one copy, got ${copies.join(',')}`)
      assert.equal(copies[0].startsWith('sessions/'), true)
      assert.equal(await exists(join(world.projectDir, 'session-1')), false)
      const staging = await readdir(join(world.sessionsRoot, '_session-bin-staging')).catch(() => [])
      assert.deepEqual(staging, [])
    },
  },
  {
    scenario: 'move-session',
    phase: 'after-registry',
    async expect({ world }) {
      const copies = await copiesOf(world)
      assert.deepEqual(copies.filter((entry) => entry.startsWith('staging/')), [])
      assert.equal(copies.length, 1)
      const target = await world.registry.resolveByPath(join(world.home, 'target'))
      assert.notEqual(target, undefined)
      assert.deepEqual(target.sessionIds, ['session-1'])
    },
  },
]

for (const entry of scenarios) await scenario(entry, entry.expect)
console.log('\ncrash injection: OK')
