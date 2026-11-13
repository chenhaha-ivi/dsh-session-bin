import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BinError, createBin } from '../src/host/trash.js'
import { createWorkspaceOps } from '../src/host/workspace.js'
import { projectKey } from '../src/host/paths.js'
import { dispose, tempHome } from './helpers.mjs'
import { createFakeRegistry, createFakeSessions, makeWorld, silentLogger } from './support/world.mjs'

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

test('survey 报告整目录模式、会话与大小', async () => {
  const world = await makeWorld({ sessionIds: ['session-1', 'session-2'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    assert.equal(plan.mode, 'project')
    assert.equal(plan.modeReason, 'project-directory-exclusive')
    assert.equal(plan.sessionCount, 2)
    assert.deepEqual(plan.sessions.map((session) => session.id), ['session-1', 'session-2'])
    assert.deepEqual(plan.collisions, [])
    assert.equal(plan.size >= 0, true)
  } finally {
    await dispose(world.home)
  }
})

test('删除工作区：整目录进回收站、登记删除、状态 done', async () => {
  const world = await makeWorld({ sessionIds: ['session-1', 'session-2'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const report = await world.ops.execute(plan)
    assert.equal(report.mode, 'project')
    assert.equal(report.moved, 1)
    assert.equal(world.registry.get('ws-1'), undefined)
    assert.equal(await exists(world.projectDir), false)

    const { entries } = await world.bin.scan()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].manifest.state, 'done')
    assert.equal(entries[0].manifest.kind, 'workspace')
    assert.deepEqual(entries[0].manifest.sessions.map((session) => session.id), ['session-1', 'session-2'])
    const binned = join(world.bin.sessionsDir(entries[0].id), world.projectKey)
    assert.equal(await exists(join(binned, 'session-1')), true)
    assert.equal(await exists(join(binned, 'session-2')), true)
    // 冷会话没有 session/disposed；必须补 api-session/removed，否则侧栏把它们扔进「未分组」。
    const removed = world.emitted.filter(([name]) => name === 'api-session/removed').map(([, id]) => id)
    assert.deepEqual(removed.sort(), ['session-1', 'session-2'])
  } finally {
    await dispose(world.home)
  }
})

test('项目目录里有别人的会话时降级逐会话，绝不整目录搬', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], extraDirs: ['session-2'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    assert.equal(plan.mode, 'per-session')
    assert.equal(plan.modeReason, 'project-directory-not-exclusive')
    assert.deepEqual(plan.extraSessionDirectories, ['session-2'])

    const report = await world.ops.execute(plan)
    assert.equal(report.mode, 'per-session')
    assert.deepEqual(report.skipped, [])
    assert.equal(await exists(join(world.projectDir, 'session-1')), false)
    assert.equal(await exists(join(world.projectDir, 'session-2')), true)
  } finally {
    await dispose(world.home)
  }
})

test('projectKey 碰撞时降级逐会话，另一个工作区的会话原地不动', async () => {
  const home = await tempHome('bin-')
  try {
    const firstPath = join(home, 'a-b')
    const secondPath = join(home, 'a', 'b')
    await mkdir(firstPath, { recursive: true })
    await mkdir(secondPath, { recursive: true })
    const sessionsRoot = join(home, 'sessions')
    const key = projectKey(firstPath)
    assert.equal(key, projectKey(secondPath))
    await mkdir(join(sessionsRoot, key, 'session-1'), { recursive: true })
    await mkdir(join(sessionsRoot, key, 'session-2'), { recursive: true })

    const registry = createFakeRegistry({
      workspaces: [
        { id: 'ws-1', path: firstPath, title: 'A', sessionIds: ['session-1'] },
        { id: 'ws-2', path: secondPath, title: 'B', sessionIds: ['session-2'] },
      ],
    })
    registry.sessionPaths.set('session-1', firstPath)
    registry.sessionPaths.set('session-2', secondPath)
    const { sessions } = createFakeSessions()
    const ctx = { get: (name) => (name === 'sessions' ? sessions : undefined), parallel: async () => {}, logger: silentLogger }
    const bin = createBin({ home })
    const ops = createWorkspaceOps({ ctx, registry, bin, sessionsRoot: () => sessionsRoot, logger: silentLogger, stopTimeoutMs: 50, stopPollMs: 10 })

    const plan = await ops.survey({ workspaceId: 'ws-1' })
    assert.equal(plan.mode, 'per-session')
    assert.equal(plan.modeReason, 'project-key-collision')
    assert.equal(plan.collisions.length, 1)

    await ops.execute(plan)
    assert.equal(await exists(join(sessionsRoot, key, 'session-1')), false)
    assert.equal(await exists(join(sessionsRoot, key, 'session-2')), true)
    assert.notEqual(registry.get('ws-2'), undefined)
  } finally {
    await dispose(home)
  }
})

test('活会话先释放再删除；释放不了就整体拒绝', async () => {
  const releasable = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'] })
  try {
    assert.deepEqual((await releasable.ops.survey({ workspaceId: 'ws-1' })).live, ['session-1'])
    const plan = await releasable.ops.survey({ workspaceId: 'ws-1' })
    await releasable.ops.execute(plan)
    assert.equal(releasable.registry.get('ws-1'), undefined)
    assert.equal(releasable.live.size, 0)
    assert.equal(releasable.liveAgents.size, 0)
  } finally {
    await dispose(releasable.home)
  }

  const stuck = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'], detachable: false })
  try {
    const plan = await stuck.ops.survey({ workspaceId: 'ws-1' })
    await assert.rejects(stuck.ops.execute(plan), binError('workspace-bin/session-busy'))
    assert.notEqual(stuck.registry.get('ws-1'), undefined)
    assert.equal(await exists(join(stuck.projectDir, 'session-1')), true)
    assert.equal((await stuck.bin.scan()).entries.length, 0)
  } finally {
    await dispose(stuck.home)
  }
})

test('agent 还挂在注册表里时也要驱逐，否则删除永远卡在 session-busy', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'] })
  try {
    // 真机复现：会话 store 的 detach 成功了，但 agent 条目还在,
    // `isLive` 永远为真，quiesce 会一直等到超时并拒绝删除。
    assert.equal(world.live.size, 1)
    assert.equal(world.liveAgents.size, 1)
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const report = await world.ops.execute(plan)
    assert.equal(report.mode, 'project')
    assert.equal(world.live.size, 0)
    assert.equal(world.liveAgents.size, 0)
    assert.equal(world.registry.get('ws-1'), undefined)
    assert.equal((await world.bin.scan()).entries.length, 1)
  } finally {
    await dispose(world.home)
  }
})

test('agent 驱逐失败时仍然整体拒绝，一个字节都不动', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], live: ['session-1'], agentsDetachable: false })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    await assert.rejects(world.ops.execute(plan), binError('workspace-bin/session-busy'))
    assert.notEqual(world.registry.get('ws-1'), undefined)
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.equal((await world.bin.scan()).entries.length, 0)
  } finally {
    await dispose(world.home)
  }
})

test('注册表删除失败时回滚文件并保留工作区', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], deleteFails: true })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    await assert.rejects(world.ops.execute(plan), binError('workspace-bin/registry-failed'))
    assert.notEqual(world.registry.get('ws-1'), undefined)
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.equal((await world.bin.scan()).entries.length, 0, '回滚干净时不该留下空条目')
  } finally {
    await dispose(world.home)
  }
})

test('隐藏子代理会话跟着工作区一起走，恢复后重新挂回', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], subagents: ['subagent-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    assert.equal(plan.sessionCount, 2)
    assert.equal(plan.sessions.find((session) => session.id === 'subagent-1').accounted, false)
    assert.equal(plan.mode, 'project', '目录里只有本工作区的会话与子代理，可以整目录搬')

    const report = await world.ops.execute(plan)
    const binned = join(world.bin.sessionsDir(report.entryId), world.projectKey)
    assert.equal(await exists(join(binned, 'session-1')), true)
    assert.equal(await exists(join(binned, 'subagent-1')), true)

    await world.ops.restore(report.entryId)
    assert.equal(await exists(join(world.projectDir, 'subagent-1')), true)
    assert.deepEqual(world.registry.get('ws-1').sessionIds.sort(), ['session-1', 'subagent-1'])
  } finally {
    await dispose(world.home)
  }
})

test('cwd 在别处的子代理会话搬不走，plan 会点名', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const otherPath = join(world.home, 'other-ws')
    await mkdir(otherPath, { recursive: true })
    world.persistence.seed(
      { version: 4, id: 'subagent-2', cwd: otherPath, parentSession: 'session-1', origin: 'subagent', createdAt: 2, isSeeded: false, delegationDepth: 1 },
      [{ seq: 0, type: 'turn/start', data: {} }],
    )
    await mkdir(join(world.sessionsRoot, projectKey(otherPath), 'subagent-2'), { recursive: true })

    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    assert.deepEqual(plan.orphanSubagents.map((entry) => entry.id), ['subagent-2'])
    await world.ops.execute(plan)
    assert.equal(await exists(join(world.sessionsRoot, projectKey(otherPath), 'subagent-2')), true, '别处的子代理不能被顺手删掉')
  } finally {
    await dispose(world.home)
  }
})

test('没有 sessions 服务时按「不活」降级，删除照常', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], noSessionsService: true })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    assert.deepEqual(plan.live, [])
    const report = await world.ops.execute(plan)
    assert.equal(report.moved, 1)
    assert.equal(world.registry.get('ws-1'), undefined)
  } finally {
    await dispose(world.home)
  }
})

test('嵌套工作区会在 plan 里被点名', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const nestedPath = join(world.workspacePath, 'nested')
    await mkdir(nestedPath, { recursive: true })
    await world.registry.create(nestedPath)
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    assert.equal(plan.nestedWorkspaces.length, 1)
    assert.equal(plan.nestedWorkspaces[0].path, nestedPath)
  } finally {
    await dispose(world.home)
  }
})

test('拒绝删除调用方自己所在的工作区', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    await assert.rejects(
      world.ops.survey({ workspaceId: 'ws-1', callerSessionId: 'session-1' }),
      binError('workspace-bin/caller-session'),
    )
  } finally {
    await dispose(world.home)
  }
})

test('未知工作区 / 缺参数有稳定错误码', async () => {
  const world = await makeWorld({ sessionIds: [] })
  try {
    await assert.rejects(world.ops.survey({ workspaceId: 'nope' }), binError('workspace-bin/unknown-workspace'))
    await assert.rejects(world.ops.survey({}), binError('workspace-bin/invalid-request'))
  } finally {
    await dispose(world.home)
  }
})

test('恢复工作区：目录回去、登记重建、归档置顶还原、条目消失', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'], archived: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const report = await world.ops.execute(plan)
    assert.deepEqual(world.registry.archivedSessionIds, [])

    const restored = await world.ops.restore(report.entryId)
    assert.equal(restored.workspaceRestored, true)
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    const workspace = await world.registry.resolveByPath(world.workspacePath)
    assert.notEqual(workspace, undefined)
    assert.equal(workspace.title, 'demo')
    assert.deepEqual(workspace.sessionIds, ['session-1'])
    assert.deepEqual(world.registry.archivedSessionIds, ['session-1'])
    assert.equal((await world.bin.scan()).entries.length, 0)

    await assert.rejects(world.ops.restore(report.entryId), binError('workspace-bin/missing-manifest'))
  } finally {
    await dispose(world.home)
  }
})

test('恢复时工作区目录已消失：只恢复会话并警告', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const report = await world.ops.execute(plan)
    await rm(world.workspacePath, { recursive: true, force: true })

    const restored = await world.ops.restore(report.entryId)
    assert.equal(restored.workspaceRestored, false)
    assert.equal(restored.warnings.some((warning) => warning.includes('workspace directory is missing')), true)
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.equal(await world.registry.resolveByPath(world.workspacePath), undefined)
    assert.equal((await world.bin.scan()).entries.length, 0)
  } finally {
    await dispose(world.home)
  }
})

test('list 给面板足够的信息', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    await world.ops.execute(plan)
    const listing = await world.ops.list()
    assert.equal(listing.entries.length, 1)
    const row = listing.entries[0]
    assert.equal(row.kind, 'workspace')
    assert.equal(row.state, 'done')
    assert.equal(row.title, 'demo')
    assert.equal(row.workspace.path, world.workspacePath)
    assert.equal(row.sessionCount, 1)
    assert.equal(row.size > 0, true)
    // 统计一次后回写 manifest，下次 list 直接读，不再递归扫盘。
    const manifest = await world.bin.readManifest(row.id)
    assert.equal(manifest.size, row.size)
  } finally {
    await dispose(world.home)
  }
})

test('manifest 里已有 size 时 list 不再递归扫盘', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    await world.ops.execute(await world.ops.survey({ workspaceId: 'ws-1' }))
    const [entry] = (await world.bin.scan()).entries
    await world.bin.writeManifest(entry.id, { ...entry.manifest, size: 12345 })
    world.bin.entrySize = async () => { throw new Error('entrySize should not be called') }
    const listing = await world.ops.list()
    assert.equal(listing.entries[0].size, 12345)
  } finally {
    await dispose(world.home)
  }
})

test('永久删除只删条目并清投影缓存；planned 条目拒绝', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const report = await world.ops.execute(plan)
    const purged = await world.ops.purge([report.entryId])
    assert.deepEqual(purged.purged, [report.entryId])
    assert.deepEqual(world.deletedCacheRows, ['session-1'])
    assert.equal((await world.bin.scan()).entries.length, 0)

    // 手工造一个 planned 条目（模拟搬了一半），empty 必须拒绝。
    const bin = createBin({ home: world.home })
    const pending = await bin.allocate({
      version: 1,
      kind: 'workspace',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { id: 'ws-9', path: '/nowhere', title: 'x', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      projectKey: '--nowhere--',
      sessions: [],
    })
    const refused = await world.ops.purge()
    assert.deepEqual(refused.purged, [])
    assert.equal(refused.errors.some((error) => error.includes('still planned')), true)
    assert.equal(await exists(bin.entryDir(pending.id)), true)
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：已搬进回收站但登记未删 -> 补完删除', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    // 手工模拟：manifest planned -> 文件已进 bin -> 登记还在。
    const entry = await world.bin.allocate({
      version: 1,
      kind: 'workspace',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { ...plan.workspace, id: 'ws-1' },
      projectKey: plan.projectKey,
      sessions: plan.sessions.map((session) => ({ id: session.id, title: session.title, archived: false, pinned: false })),
    })
    const destination = join(world.bin.sessionsDir(entry.id), plan.projectKey)
    await mkdir(destination, { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(world.projectDir, destination)

    const result = await world.ops.recover()
    assert.deepEqual(result.recovered, [{ id: entry.id, action: 'completed' }])
    assert.equal(world.registry.get('ws-1'), undefined)
    const { entries } = await world.bin.scan()
    assert.equal(entries[0].manifest.state, 'done')
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：什么都没搬 -> 丢弃空条目，工作区不动', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const entry = await world.bin.allocate({
      version: 1,
      kind: 'workspace',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { ...plan.workspace, id: 'ws-1' },
      projectKey: plan.projectKey,
      sessions: [],
    })
    const result = await world.ops.recover()
    assert.deepEqual(result.recovered, [{ id: entry.id, action: 'discarded-noop' }])
    assert.notEqual(world.registry.get('ws-1'), undefined)
    assert.equal(await exists(join(world.projectDir, 'session-1')), true)
    assert.equal((await world.bin.scan()).entries.length, 0)
  } finally {
    await dispose(world.home)
  }
})

test('启动恢复：文件已进 bin 且登记已删 -> 只补 done', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const plan = await world.ops.survey({ workspaceId: 'ws-1' })
    const entry = await world.bin.allocate({
      version: 1,
      kind: 'workspace',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { ...plan.workspace, id: 'ws-1' },
      projectKey: plan.projectKey,
      sessions: plan.sessions.map((session) => ({ id: session.id, title: session.title, archived: false, pinned: false })),
    })
    const destination = join(world.bin.sessionsDir(entry.id), plan.projectKey)
    await mkdir(destination, { recursive: true })
    const { rename } = await import('node:fs/promises')
    await rename(world.projectDir, destination)
    await world.registry.delete('ws-1')

    const result = await world.ops.recover()
    assert.deepEqual(result.recovered, [{ id: entry.id, action: 'completed' }])
    assert.equal((await world.bin.scan()).entries[0].manifest.state, 'done')
  } finally {
    await dispose(world.home)
  }
})

test('保存失败条目时不清掉数据（failed 可被 list 看到）', async () => {
  const world = await makeWorld({ sessionIds: ['session-1'] })
  try {
    const bin = createBin({ home: world.home })
    const entry = await bin.allocate({
      version: 1,
      kind: 'workspace',
      createdAt: new Date().toISOString(),
      state: 'planned',
      workspace: { id: 'ws-1', path: world.workspacePath, title: 'demo', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      projectKey: world.projectKey,
      sessions: [{ id: 'session-1', title: '', archived: false, pinned: false }],
    })
    await bin.transition(entry.id, 'failed', { error: 'boom' })
    const listing = await world.ops.list()
    assert.equal(listing.entries[0].state, 'failed')
    assert.equal(listing.entries[0].error, 'boom')
  } finally {
    await dispose(world.home)
  }
})
