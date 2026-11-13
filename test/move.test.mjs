import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BinError } from '../src/host/trash.js'
import { projectKey } from '../src/host/paths.js'
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

/** 建一个目标工作区（真实目录 + 注册表记录）。 */
async function addTarget(world, name = 'target') {
  const path = join(world.home, name)
  await mkdir(path, { recursive: true })
  const workspace = await world.registry.create(path)
  return { path, workspace }
}

/** 回收站暂存区里还剩什么。 */
async function stagingEntries(world) {
  try {
    return await readdir(join(world.sessionsRoot, '_session-bin-staging'))
  } catch {
    return []
  }
}

test('正在跑的会话允许搬移：先停再搬，回执 stoppedRunning=true', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'], running: ['session-1'] })
  try {
    const target = await addTarget(world)
    const report = await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id })
    assert.equal(report.applied, 'moved')
    assert.equal(report.stoppedRunning, true)
    assert.equal(await exists(join(world.projectDir, 'session-1')), false)
    assert.deepEqual(world.registry.get(target.workspace.id).sessionIds, ['session-1'])
  } finally {
    await dispose(world.home)
  }
})

test('移动带子代理的会话：只搬父会话，并在 warnings 里点名留下的子代理', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], subagents: ['subagent-1'] })
  try {
    const target = await addTarget(world)
    const report = await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id })
    assert.equal(report.applied, 'moved')
    assert.equal(report.warnings.some((warning) => warning.includes('subagent-1')), true)
    assert.equal(await exists(join(world.projectDir, 'subagent-1')), true)
  } finally {
    await dispose(world.home)
  }
})

test('跨区移动只改单条 header 索引，不做全量重建', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    let fullRefreshes = 0
    world.registry.listStoredHeaders = async () => { fullRefreshes += 1; return [] }
    world.registry.replaceHeaderIndex = async () => { fullRefreshes += 1 }
    const target = await addTarget(world)
    await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id })
    assert.equal(fullRefreshes, 0)
    assert.equal(world.registry.headers.get('session-1').cwd, target.path)
  } finally {
    await dispose(world.home)
  }
})

test('跨区移动：后继 artifact 建到目标、源目录删除、归属改写', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const target = await addTarget(world)
    // 预置一条投影缓存：跨区移动应保留它、只把 identity.cwd 指向新目录。
    world.cacheRows.set('session-1', {
      identity: { formatVersion: 4, createdAt: 1, cwd: world.workspacePath, isSeeded: false },
      rows: { title: { ver: 1, seq: 1, val: 'hello' } },
    })
    const report = await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id })

    assert.equal(report.applied, 'moved')
    assert.equal(report.events, 2)
    assert.equal(report.lastSeq, 1)
    assert.equal(await exists(join(world.projectDir, 'session-1')), false)
    assert.equal(await exists(join(world.sessionsRoot, projectKey(target.path), 'session-1')), true)
    assert.equal(world.persistence.headers.get('session-1').cwd, target.path)
    assert.deepEqual(world.persistence.events.get('session-1').map((event) => event.seq), [0, 1])

    assert.deepEqual(target.workspace.sessionIds, ['session-1'])
    assert.deepEqual(world.registry.get('ws-1').sessionIds, [])
    assert.deepEqual(await stagingEntries(world), [])
    assert.deepEqual(world.deletedCacheRows, [], '缓存不能被删，否则冷列表会显示未命名')
    const cached = world.cacheRows.get('session-1')
    assert.equal(cached.identity.cwd, target.path)
    assert.equal(cached.rows.title.val, 'hello')
  } finally {
    await dispose(world.home)
  }
})

test('移动后源工作区的持久记录里不残留会话（不会同时出现在两个工作区）', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const target = await addTarget(world)
    await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id })
    // sessionPaths 已经指向目标，源工作区的 getter 本来就看不见它了；
    // 这里断言的是**记录本身**也被清掉，否则侧栏会同时显示在两个分组里。
    assert.deepEqual(world.registry.get('ws-1').record.sessionIds, [])
    assert.deepEqual(target.workspace.record.sessionIds, ['session-1'])
  } finally {
    await dispose(world.home)
  }
})

test('跨区移动保留 seeded 会话的继承前缀长度', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], seeded: true })
  try {
    const target = await addTarget(world)
    await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id })
    assert.equal(world.persistence.headers.get('session-1').isSeeded, true)
    assert.equal(world.persistence.owners.has('session-1'), false, '写句柄必须已经释放')
  } finally {
    await dispose(world.home)
  }
})

test('targetPath 不存在注册表时自动登记新工作区', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const path = join(world.home, 'fresh-target')
    await mkdir(path, { recursive: true })
    const report = await world.ops.relocate({ sessionId: 'session-1', targetPath: path })
    assert.equal(report.applied, 'moved')
    const workspace = await world.registry.resolveByPath(path)
    assert.notEqual(workspace, undefined)
    assert.equal(report.targetWorkspaceId, workspace.id)
    assert.deepEqual(workspace.sessionIds, ['session-1'])
  } finally {
    await dispose(world.home)
  }
})

test('目标就是当前工作区：already-there，一个字节都不动', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const report = await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: 'ws-1' })
    assert.equal(report.applied, 'already-there')
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(await stagingEntries(world), [])
  } finally {
    await dispose(world.home)
  }
})

test('活会话停不下来时拒绝移动，源目录不动', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'], detachable: false })
  try {
    const target = await addTarget(world)
    await assert.rejects(
      world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id }),
      binError('session-bin/session-busy'),
    )
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(await stagingEntries(world), [])
  } finally {
    await dispose(world.home)
  }
})

test('create 失败：暂存区回滚、源目录回位、归属不变', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], failCreate: true })
  try {
    const target = await addTarget(world)
    await assert.rejects(
      world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id }),
      binError('session-bin/move-failed'),
    )
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(await stagingEntries(world), [])
    assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-1'])
    assert.deepEqual(target.workspace.sessionIds, [])
  } finally {
    await dispose(world.home)
  }
})

test('归属写入失败：文件已就位，留 committed 日志等重启补齐', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const path = join(world.home, 'flaky-target')
    await mkdir(path, { recursive: true })
    const target = await world.registry.create(path)
    // 让 attach 在这个目标上失败（模拟注册表拒绝）。
    target.attachFails = true
    world.registry.attachFails = true
    world.registry.list = () => [world.registry.get('ws-1'), target]

    const report = await world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.id })
    assert.equal(report.applied, 'moved')
    assert.equal(report.registry.applied, false)
    assert.equal(report.warnings.some((warning) => warning.includes('workspace membership')), true)
    assert.equal(await exists(join(world.sessionsRoot, projectKey(path), 'session-1')), true)

    const ops = await readdir(join(world.sessionsRoot, '_session-bin-staging'))
    assert.equal(ops.length, 1)
    const journal = JSON.parse(await readFile(join(world.sessionsRoot, '_session-bin-staging', ops[0], 'journal.json'), 'utf8'))
    assert.equal(journal.phase, 'committed')
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：目标已可用 -> 补归属并清暂存区', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const target = await addTarget(world)
    const header = world.persistence.headers.get('session-1')
    const events = world.persistence.events.get('session-1')

    // 造一个「源已 park、后继已建、没来得及清暂存区」的中间态。
    const opDir = join(world.sessionsRoot, '_session-bin-staging', 'op-recover')
    await mkdir(opDir, { recursive: true })
    await rename(join(world.projectDir, 'session-1'), join(opDir, 'session-1'))
    const writer = await world.persistence.create({ ...header, cwd: target.path })
    await writer.append(events)
    await writer.flush()
    await writer.close()
    await writeFile(join(opDir, 'journal.json'), JSON.stringify({
      version: 1,
      opId: 'op-recover',
      sessionId: 'session-1',
      fromCwd: world.workspacePath,
      toCwd: target.path,
      createdAt: new Date().toISOString(),
      events: 2,
      lastSeq: 1,
    }))

    const result = await world.ops.recoverMoves()
    assert.deepEqual(result.recovered, [{ opId: 'op-recover', sessionId: 'session-1', action: 'completed' }])
    assert.deepEqual(await stagingEntries(world), [])
    assert.deepEqual(target.workspace.sessionIds, ['session-1'])
    assert.deepEqual(world.registry.get('ws-1').sessionIds, [])
    assert.equal(await exists(join(world.sessionsRoot, projectKey(target.path), 'session-1')), true)
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：目标不可用 -> 回滚到源目录', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const target = await addTarget(world)
    const opDir = join(world.sessionsRoot, '_session-bin-staging', 'op-rollback')
    await mkdir(opDir, { recursive: true })
    await rename(join(world.projectDir, 'session-1'), join(opDir, 'session-1'))
    await writeFile(join(opDir, 'journal.json'), JSON.stringify({
      version: 1,
      opId: 'op-rollback',
      sessionId: 'session-1',
      fromCwd: world.workspacePath,
      toCwd: target.path,
      createdAt: new Date().toISOString(),
      events: 2,
      lastSeq: 1,
    }))

    const result = await world.ops.recoverMoves()
    assert.deepEqual(result.recovered, [{ opId: 'op-rollback', sessionId: 'session-1', action: 'rolled-back' }])
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(await stagingEntries(world), [])
    assert.deepEqual(world.registry.get('ws-1').sessionIds, ['session-1'])
  } finally {
    await dispose(world.home)
  }
})

test('超大日志在整段读之前就被拒绝', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], sizeBytes: 300 * 1024 * 1024 })
  try {
    const target = await addTarget(world)
    await assert.rejects(
      world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id }),
      binError('session-bin/session-too-large'),
    )
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(await stagingEntries(world), [])
  } finally {
    await dispose(world.home)
  }
})

test('目标工作区目录已消失或不是目录：拒绝移动，源与暂存区不动', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const target = await addTarget(world)
    await rm(target.path, { recursive: true, force: true })
    await assert.rejects(
      world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: target.workspace.id }),
      binError('session-bin/target-path-missing'),
    )
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.deepEqual(await stagingEntries(world), [])

    const file = join(world.home, 'not-a-directory')
    await writeFile(file, 'x')
    await assert.rejects(
      world.ops.relocate({ sessionId: 'session-1', targetPath: file }),
      binError('session-bin/target-path-missing'),
    )
  } finally {
    await dispose(world.home)
  }
})

test('移动未知会话 / 未知目标工作区有稳定错误码', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    await assert.rejects(world.ops.relocate({ sessionId: 'session-x', targetWorkspaceId: 'ws-1' }), binError('session-bin/unknown-session'))
    await assert.rejects(world.ops.relocate({ sessionId: 'session-1', targetWorkspaceId: 'nope' }), binError('session-bin/unknown-target-workspace'))
    await assert.rejects(world.ops.relocate({ sessionId: 'session-1' }), binError('session-bin/invalid-request'))
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：旧版本的 _workspace-bin-staging 先迁到新目录再补完', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const target = await addTarget(world)
    const header = world.persistence.headers.get('session-1')
    const events = world.persistence.events.get('session-1')

    // 升级前崩在搬移中途：暂存区还在旧名字下面。
    const opDir = join(world.sessionsRoot, '_workspace-bin-staging', 'op-legacy')
    await mkdir(opDir, { recursive: true })
    await rename(join(world.projectDir, 'session-1'), join(opDir, 'session-1'))
    const writer = await world.persistence.create({ ...header, cwd: target.path })
    await writer.append(events)
    await writer.flush()
    await writer.close()
    await writeFile(join(opDir, 'journal.json'), JSON.stringify({
      version: 1,
      opId: 'op-legacy',
      sessionId: 'session-1',
      fromCwd: world.workspacePath,
      toCwd: target.path,
      createdAt: new Date().toISOString(),
      events: 2,
      lastSeq: 1,
    }))

    const result = await world.ops.recoverMoves()
    assert.deepEqual(result.recovered, [{ opId: 'op-legacy', sessionId: 'session-1', action: 'completed' }])
    assert.equal(await exists(join(world.sessionsRoot, '_workspace-bin-staging')), false)
    assert.deepEqual(await stagingEntries(world), [])
    assert.equal(await exists(join(world.sessionsRoot, projectKey(target.path), 'session-1')), true)
  } finally {
    await dispose(world.home)
  }
})
