import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { trashPathToOs } from '../src/host/os-trash.js'
import { dispose, tempHome } from './helpers.mjs'

test('非 macOS 走 Electron shell.trashItem', async () => {
  const calls = []
  const result = await trashPathToOs('/tmp/whatever', {
    platform: 'win32',
    electronShell: { trashItem: async (path) => { calls.push(path) } },
  })
  assert.deepEqual(calls, ['/tmp/whatever'])
  assert.equal(result.via, 'electron')
})

test('macOS 退路：rename 进 ~/.Trash', async () => {
  const home = await tempHome('trash-')
  try {
    await mkdir(join(home, '.Trash'), { recursive: true })
    const workspace = join(home, 'project')
    await mkdir(workspace, { recursive: true })
    const result = await trashPathToOs(workspace, { electronShell: null, platform: 'darwin', home })
    assert.equal(result.via, 'macos-trash')
    assert.equal(result.target, join(home, '.Trash', 'project'))
    assert.deepEqual(await readdir(join(home, '.Trash')), ['project'])
    await assert.rejects(stat(workspace), /ENOENT/)
  } finally {
    await dispose(home)
  }
})

test('~/.Trash 里重名时加时间后缀', async () => {
  const home = await tempHome('trash-')
  try {
    await mkdir(join(home, '.Trash'), { recursive: true })
    await mkdir(join(home, '.Trash', 'project'))
    const workspace = join(home, 'project')
    await mkdir(workspace)
    const result = await trashPathToOs(workspace, { electronShell: null, platform: 'darwin', home })
    assert.notEqual(basename(result.target), 'project')
    assert.equal(basename(result.target).startsWith('project '), true)
  } finally {
    await dispose(home)
  }
})

test('macOS 跨卷 rename 失败时交给 Electron', async () => {
  const home = await tempHome('trash-')
  const calls = []
  try {
    await mkdir(join(home, '.Trash'), { recursive: true })
    const workspace = join(home, 'project')
    await mkdir(workspace)
    const result = await trashPathToOs(workspace, {
      platform: 'darwin',
      home,
      // 让 ~/.Trash 看起来在另一个设备上，强制走 Electron。
      stat: async (path) => (path === workspace ? { dev: 1 } : { dev: 2 }),
      electronShell: { trashItem: async (path) => { calls.push(path) } },
    })
    assert.equal(result.via, 'electron')
    assert.deepEqual(calls, [workspace])
  } finally {
    await dispose(home)
  }
})

test('跨卷时不硬搬，明确拒绝', async () => {
  const home = await tempHome('trash-')
  try {
    await mkdir(join(home, '.Trash'), { recursive: true })
    const workspace = join(home, 'project')
    await mkdir(workspace)
    await assert.rejects(
      trashPathToOs(workspace, {
        electronShell: null,
        platform: 'darwin',
        home,
        stat: async (path) => (path === workspace ? { dev: 1 } : { dev: 2 }),
      }),
      /cross-volume/,
    )
  } finally {
    await dispose(home)
  }
})

test('没有 Electron 又不是 macOS：拒绝而不是 rm -rf', async () => {
  await assert.rejects(
    trashPathToOs('/tmp/whatever', { electronShell: null, platform: 'win32' }),
    /no OS trash implementation/,
  )
})
