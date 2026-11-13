import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BinError,
  ENTRY_ID_PATTERN,
  MANIFEST_NAME,
  createBin,
  entryIdOf,
  validateManifest,
} from '../src/host/trash.js'
import { dispose, tempHome, workspaceManifest } from './helpers.mjs'

test('entryIdOf 生成可排序的 yyyyMMddTHHmmss-6hex', () => {
  const id = entryIdOf(new Date('2026-11-12T13:31:00.000Z'), () => Buffer.from([0xab, 0x12, 0x34]))
  assert.equal(id, '20261112T133100-ab1234')
  assert.match(id, ENTRY_ID_PATTERN)
})

test('allocate + readManifest 往返，目录结构齐全', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    const manifest = workspaceManifest()
    const entry = await bin.allocate(manifest)
    assert.match(entry.id, ENTRY_ID_PATTERN)
    assert.equal(bin.root, join(home, 'workspace-bin'))
    assert.deepEqual(await bin.readManifest(entry.id), manifest)
    assert.equal((await readdir(entry.dir)).includes(MANIFEST_NAME), true)
    assert.equal((await readdir(bin.sessionsDir(entry.id))).length, 0)
  } finally {
    await dispose(home)
  }
})

test('allocate 拒绝非法 manifest', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    await assert.rejects(
      bin.allocate(workspaceManifest({ version: 2 })),
      (error) => error instanceof BinError && error.code === 'workspace-bin/bad-manifest',
    )
    // 非法 manifest 不该留下半个条目目录。
    const { entries, broken } = await bin.scan()
    assert.equal(entries.length + broken.length, 0)
  } finally {
    await dispose(home)
  }
})

test('validateManifest 覆盖结构约束', () => {
  assert.deepEqual(validateManifest(workspaceManifest()), [])
  assert.match(validateManifest(null)[0], /JSON object/)
  assert.match(validateManifest(workspaceManifest({ kind: 'nope' }))[0], /kind must be/)
  assert.match(validateManifest(workspaceManifest({ state: 'halfway' }))[0], /state must be/)
  assert.match(
    validateManifest(workspaceManifest({ workspace: { id: 'ws-1' } })).join(';'),
    /kind=workspace requires a workspace record/,
  )
  assert.match(
    validateManifest(workspaceManifest({ sessions: [{ id: '../escape' }] })).join(';'),
    /plain session id/,
  )
})

test('readManifest 区分缺失与损坏', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    const id = '20260101T000000-aaaaaa'
    await mkdir(join(bin.root, id), { recursive: true })
    await assert.rejects(bin.readManifest(id), (error) => error.code === 'workspace-bin/missing-manifest')

    await writeFile(bin.manifestPath(id), '{not json', 'utf8')
    await assert.rejects(bin.readManifest(id), (error) => error.code === 'workspace-bin/bad-manifest')
  } finally {
    await dispose(home)
  }
})

test('状态机只允许 planned -> done/failed，同状态幂等', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    const { id } = await bin.allocate(workspaceManifest())
    assert.equal((await bin.transition(id, 'planned')).state, 'planned')
    const done = await bin.transition(id, 'done', { finishedAt: '2026-11-12T13:32:00.000Z' })
    assert.equal(done.state, 'done')
    assert.equal(done.finishedAt, '2026-11-12T13:32:00.000Z')
    await assert.rejects(
      bin.transition(id, 'planned'),
      (error) => error instanceof BinError && error.code === 'workspace-bin/bad-transition',
    )
    assert.equal((await bin.readManifest(id)).state, 'done')
  } finally {
    await dispose(home)
  }
})

test('scan 报告损坏条目、忽略非条目目录，并按时间倒序', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    await bin.ensure()
    const older = '20260101T000000-aaaaaa'
    const newer = '20260102T000000-bbbbbb'
    for (const id of [older, newer]) {
      await mkdir(join(bin.root, id), { recursive: true })
      await bin.writeManifest(id, workspaceManifest())
    }
    const broken = '20260103T000000-cccccc'
    await mkdir(join(bin.root, broken), { recursive: true })
    // 非条目目录（不是我们的命名）必须被忽略。
    await mkdir(join(bin.root, 'scratch-notes'), { recursive: true })

    const result = await bin.scan()
    assert.deepEqual(result.entries.map((entry) => entry.id), [newer, older])
    assert.deepEqual(result.broken.map((entry) => entry.id), [broken])
    assert.match(result.broken[0].reason, /no manifest/)
  } finally {
    await dispose(home)
  }
})

test('removeEntry 只删指定条目；entrySize 统计嵌套文件', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    const first = await bin.allocate(workspaceManifest())
    const second = await bin.allocate(workspaceManifest())
    const nested = join(bin.sessionsDir(first.id), '--tmp-ws--', 'session-1')
    await mkdir(nested, { recursive: true })
    const before = await bin.entrySize(first.id)
    await writeFile(join(nested, 'session.v4.jsonl.zstd'), Buffer.alloc(123))

    assert.equal((await bin.entrySize(first.id)) - before, 123)

    await bin.removeEntry(first.id)
    const { entries } = await bin.scan()
    assert.deepEqual(entries.map((entry) => entry.id), [second.id])
  } finally {
    await dispose(home)
  }
})

test('原子写不留临时文件', async () => {
  const home = await tempHome()
  try {
    const bin = createBin({ home })
    const { id, dir } = await bin.allocate(workspaceManifest())
    await bin.transition(id, 'done')
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
    assert.match(await readFile(bin.manifestPath(id), 'utf8'), /"state": "done"/)
  } finally {
    await dispose(home)
  }
})
