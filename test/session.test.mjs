import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BinError } from '../src/host/trash.js'
import { dispose } from './helpers.mjs'
import { makeWorld } from './support/world.mjs'

/** 路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 等价的 BinError 断言。 */
function binError(code) {
  return (error) => error instanceof BinError && error.code === code
}

test('surveySession 报告会话、归属与目录', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ sessionId: 'session-1' })
    assert.equal(plan.kind, 'session')
    assert.equal(plan.session.id, 'session-1')
    assert.equal(plan.session.cwd, world.workspacePath)
    assert.equal(plan.workspace.id, 'ws-1')
    assert.equal(plan.sessionDir, join(world.projectDir, 'session-1'))
    assert.equal(plan.sessionCount, 1)
  } finally {
    await dispose(world.home)
  }
})

test('正在跑的会话拒绝回收，survey 与 execute 都不碰文件', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'], running: ['session-1'] })
  try {
    await assert.rejects(world.ops.survey({ sessionId: 'session-1' }), binError('workspace-bin/session-running'))
    await assert.rejects(world.ops.execute({ kind: 'session', session: { id: 'session-1' } }), binError('workspace-bin/session-running'))
    assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-1'])
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.equal((await world.bin.scan()).entries.length, 0)
  } finally {
    await dispose(world.home)
  }
})

test('删除单会话：目录进回收站、摘归属、状态 done', async () => {
  const world = await makeWorld({ sessionIds: ['session-1', 'session-2'], archived: ['session-1'] })
  try {
    const plan = await world.ops.survey({ sessionId: 'session-1' })
    const report = await world.ops.execute(plan)
    assert.equal(report.entryId.length > 0, true)
    assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-2'])
    assert.deepEqual(world.registry.archivedSessionIds, [])
    assert.equal(await exists(join(world.projectDir, 'session-1')), false)
    assert.equal(await exists(join(world.projectDir, 'session-2')), true)

    const { entries } = await world.bin.scan()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].manifest.kind, 'session')
    assert.equal(entries[0].manifest.state, 'done')
    assert.equal(entries[0].manifest.workspace.id, 'ws-1')
    assert.equal(await exists(join(world.bin.sessionsDir(entries[0].id), world.projectKey, 'session-1')), true)
  } finally {
    await dispose(world.home)
  }
})

test('删除会话后工作区的持久记录里不残留', async () => {
  const world = await makeWorld({ sessionIds: ['session-1', 'session-2'] })
  try {
    await world.ops.execute(await world.ops.survey({ sessionId: 'session-1' }))
    assert.deepEqual(world.registry.get('ws-1').record.sessionIds, ['session-2'])
    assert.deepEqual(world.emitted.filter(([name]) => name === 'api-session/removed'), [['api-session/removed', 'session-1']])
  } finally {
    await dispose(world.home)
  }
})

test('恢复单会话：目录回位、归属与归档还原、条目消失', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], archived: ['session-1'] })
  try {
    const report = await world.ops.execute(await world.ops.survey({ sessionId: 'session-1' }))
    const restored = await world.ops.restore(report.entryId)
    assert.equal(restored.kind, 'session')
    assert.deepEqual(restored.restored, ['session-1'])
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-1'])
    assert.deepEqual(world.registry.archivedSessionIds, ['session-1'])
    assert.equal((await world.bin.scan()).entries.length, 0)
  } finally {
    await dispose(world.home)
  }
})

test('原工作区已不存在时，恢复成未分组会话并警告', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const report = await world.ops.execute(await world.ops.survey({ sessionId: 'session-1' }))
    await world.registry.delete('ws-1')

    const restored = await world.ops.restore(report.entryId)
    assert.equal(restored.workspaceRestored, false)
    assert.equal(restored.warnings.some((warning) => warning.includes('restored ungrouped')), true)
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
  } finally {
    await dispose(world.home)
  }
})

test('活会话先释放；释放不了就拒绝且不动文件', async () => {
  const releasable = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'] })
  try {
    const report = await releasable.ops.execute(await releasable.ops.survey({ sessionId: 'session-1' }))
    assert.equal(report.moved, 1)
    assert.equal(releasable.live.size, 0)
  } finally {
    await dispose(releasable.home)
  }

  const stuck = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'], detachable: false })
  try {
    const plan = await stuck.ops.survey({ sessionId: 'session-1' })
    await assert.rejects(stuck.ops.execute(plan), binError('workspace-bin/session-busy'))
    assert.equal(await exists(join(stuck.projectDir, 'session-1')), true)
    assert.equal((await stuck.bin.scan()).entries.length, 0)
  } finally {
    await dispose(stuck.home)
  }
})

test('未知会话 / 调用方自己 / 没有目录 的错误码', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    await assert.rejects(world.ops.survey({ sessionId: 'session-unknown' }), binError('workspace-bin/unknown-session'))
    await assert.rejects(
      world.ops.survey({ sessionId: 'session-1', callerSessionId: 'session-1' }),
      binError('workspace-bin/caller-session'),
    )
    await rm(join(world.projectDir, 'session-1'), { recursive: true, force: true })
    await assert.rejects(world.ops.survey({ sessionId: 'session-1' }), binError('workspace-bin/no-session-directory'))
  } finally {
    await dispose(world.home)
  }
})

test('恢复冲突：目标目录已存在时拒绝并保留条目', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const report = await world.ops.execute(await world.ops.survey({ sessionId: 'session-1' }))
    await mkdir(join(world.projectDir, 'session-1'), { recursive: true })
    await assert.rejects(world.ops.restore(report.entryId), binError('workspace-bin/restore-conflict'))
    assert.equal((await world.bin.scan()).entries.length, 1)
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：会话条目已搬进回收站 -> 摘归属并补 done', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], archived: ['session-1'] })
  try {
    const entry = await world.bin.allocate({
      version: 1,
      kind: 'session',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { id: 'ws-1', path: world.workspacePath, title: 'demo' },
      projectKey: world.projectKey,
      sessions: [{ id: 'session-1', title: '', archived: true, pinned: false }],
    })
    const destination = join(world.bin.sessionsDir(entry.id), world.projectKey)
    await mkdir(destination, { recursive: true })
    await rename(join(world.projectDir, 'session-1'), join(destination, 'session-1'))

    const result = await world.ops.recover()
    assert.deepEqual(result.recovered, [{ id: entry.id, action: 'completed' }])
    assert.deepEqual(world.registry.get('ws-1').sessionIds, [])
    assert.deepEqual(world.registry.archivedSessionIds, [])
    assert.equal((await world.bin.scan()).entries[0].manifest.state, 'done')
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：会话条目什么都没搬 -> 丢弃空条目', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const entry = await world.bin.allocate({
      version: 1,
      kind: 'session',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { id: 'ws-1', path: world.workspacePath, title: 'demo' },
      projectKey: world.projectKey,
      sessions: [{ id: 'session-1', title: '', archived: false, pinned: false }],
    })
    const result = await world.ops.recover()
    assert.deepEqual(result.recovered, [{ id: entry.id, action: 'discarded-empty' }])
    assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-1'])
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
  } finally {
    await dispose(world.home)
  }
})
