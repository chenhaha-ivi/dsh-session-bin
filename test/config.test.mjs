import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, resolveHome } from '../src/host/index.js'
import { createConfigOps } from '../src/host/config.js'

/** 用插件的真 Config 建门面，只把 ctx/编辑器换成假的。 */
function makeOps({ config = {}, entries = 'one', edit } = {}) {
  const entry = { options: { id: 'session-bin', name: 'dsh-session-bin', config: { ...config } } }
  const calls = []
  const editor = {
    entries: () => (entries === 'none' ? [] : [entry]),
    edit: edit ?? (async (target, change) => {
      const next = change(target.options.config, {})
      target.options.config = next
      calls.push(['edit', next])
    }),
  }
  const ctx = { get: (name) => (name === 'configEditor' ? editor : undefined) }
  const ops = createConfigOps({
    ctx,
    validate: (value) => Config['~standard'].validate(value),
    resolveHome,
  })
  return { ops, entry, calls, editor }
}

test('没有 configEditor 时明确报告不可用，不假装能写', () => {
  const ops = createConfigOps({
    ctx: { get: () => undefined },
    validate: (value) => Config['~standard'].validate(value),
    resolveHome,
  })
  assert.deepEqual(ops.read(), { available: false, reason: 'no-editor', config: null, home: null })
})

test('configEditor 在、但这一行不在 profile 里 → no-entry', () => {
  const { ops } = makeOps({ entries: 'none' })
  assert.equal(ops.read().available, false)
  assert.equal(ops.read().reason, 'no-entry')
})

test('读出来的配置是规范化后的：缺省 false、home 去空白', () => {
  const empty = makeOps().ops.read()
  assert.deepEqual(empty.config, { trashWorkspaceFolder: false })
  assert.equal(empty.home, resolveHome({ trashWorkspaceFolder: false }))

  const custom = makeOps({ config: { home: '/tmp/dsh-home', trashWorkspaceFolder: true } }).ops.read()
  assert.deepEqual(custom.config, { trashWorkspaceFolder: true, home: '/tmp/dsh-home' })
  assert.equal(custom.home, '/tmp/dsh-home')
})

test('保存开关：只写已知键，回执带新配置与回收站根目录', async () => {
  const { ops, calls } = makeOps({ config: {} })
  const result = await ops.save({ trashWorkspaceFolder: true })
  assert.equal(result.saved, true)
  assert.deepEqual(result.config, { trashWorkspaceFolder: true })
  assert.equal(result.home, resolveHome({ trashWorkspaceFolder: true }))
  assert.deepEqual(calls, [['edit', { trashWorkspaceFolder: true }]])
})

test('home 传 null / 空串表示清空', async () => {
  const cleared = await makeOps({ config: { home: '/tmp/h', trashWorkspaceFolder: false } }).ops.save({ home: null })
  assert.deepEqual(cleared.config, { trashWorkspaceFolder: false })
  const blank = await makeOps({ config: { home: '/tmp/h', trashWorkspaceFolder: false } }).ops.save({ home: '  ' })
  assert.deepEqual(blank.config, { trashWorkspaceFolder: false })
})

test('未知键 / 类型错误被拒，且一个字节都不写', async () => {
  const unknown = makeOps()
  await assert.rejects(unknown.ops.save({ trashWorkspacFolder: true }), (error) => {
    assert.equal(error.code, 'session-bin/invalid-config')
    assert.match(error.message, /unknown config key/)
    return true
  })
  assert.deepEqual(unknown.calls, [])

  const wrongType = makeOps()
  await assert.rejects(wrongType.ops.save({ trashWorkspaceFolder: 'yes' }), (error) => {
    assert.equal(error.code, 'session-bin/invalid-config')
    return true
  })
  await assert.rejects(wrongType.ops.save({ home: 5 }), (error) => {
    assert.equal(error.code, 'session-bin/invalid-config')
    return true
  })
  assert.deepEqual(wrongType.calls, [])
})

test('configEditor 写失败会包成稳定错误码，客户端有话说', async () => {
  const { ops } = makeOps({ edit: async () => { throw new Error('profile patch is read-only') } })
  await assert.rejects(ops.save({ trashWorkspaceFolder: false }), (error) => {
    assert.equal(error.code, 'session-bin/config-write-failed')
    assert.match(error.message, /profile patch is read-only/)
    return true
  })
})

test('Config schema 仍是唯一真相：写进去的候选必须能过激活校验', async () => {
  const { ops, entry } = makeOps({ config: { home: '/tmp/h' } })
  await ops.save({ trashWorkspaceFolder: true })
  const validated = Config['~standard'].validate(entry.options.config)
  assert.equal(validated.issues, undefined)
  assert.equal(validated.value.trashWorkspaceFolder, true)
  assert.equal(validated.value.home, '/tmp/h')
})
