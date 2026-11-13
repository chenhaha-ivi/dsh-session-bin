import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

/** 包清单是安装时的第一道门：字段错了，插件根本不进加载队列。 */
test('package.json 的 DSH 清单字段齐全', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-workspace-bin')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './host.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(Array.isArray(pkg.dsh.client.inject), true)
  assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'), true)
  assert.match(pkg.dsh.engines.dsh, /0\.2\.2-rc\.1/)
  assert.match(pkg.engines.node, />=22/)
  for (const file of ['host.js', 'client.js', 'src', 'cordis.patch.yml', 'README.md']) {
    assert.equal(pkg.files.includes(file), true, `files 缺 ${file}`)
  }
})

test('cordis.patch.yml 插入自己这一行', async () => {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(text, /- insert:/)
  assert.match(text, /id: workspace-bin/)
  assert.match(text, /name: dsh-workspace-bin/)
})
