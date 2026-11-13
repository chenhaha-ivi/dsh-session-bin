import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, stat } from 'node:fs/promises'

/** 包清单是安装时的第一道门：字段错了，插件根本不进加载队列。 */
test('package.json 的 DSH 清单字段齐全', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'dsh-session-bin')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['.'], './host.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(Array.isArray(pkg.dsh.client.inject), true)
  assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'), true)
  assert.match(pkg.engines.dsh, /0\.2\.2-rc\.1/)
  assert.match(pkg.engines.node, />=22/)
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.author, 'webchenming')
  assert.equal(pkg.scripts.prepublishOnly, 'npm test')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const file of [
    'host.js',
    'client.js',
    'src',
    'cordis.patch.yml',
    'locale/*.json',
    'docs',
    'README.md',
    'icon.svg',
  ]) {
    assert.equal(pkg.files.includes(file), true, `files 缺 ${file}`)
  }
})

/** 插件页显示的是 locale 里的 meta；路径写错会显示诊断而不是详情页。 */
test('locale 元数据与详情页资源齐全', async () => {
  for (const [locale, detail] of [
    ['zh', 'docs/DETAIL.zh.md'],
    ['en', 'docs/DETAIL.md'],
  ]) {
    const meta = JSON.parse(await readFile(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8')).meta
    assert.ok(meta.title.length > 0, `${locale} 缺 meta.title`)
    assert.ok(meta.description.length > 40, `${locale} 的 meta.description 太短`)
    assert.equal(meta.detail, detail)
    const doc = await readFile(new URL(`../${detail}`, import.meta.url), 'utf8')
    const image = /^!\[[^\]]+\]\((preview\.svg)\)\s*$/.exec(doc.trim())
    assert.ok(image, `${detail} 必须是单张预览图`)
    const svg = await readFile(new URL(`../docs/${image[1]}`, import.meta.url), 'utf8')
    assert.match(svg, /width="640"\s+height="300"/)
    assert.match(svg, /viewBox="0 0 640 300"/)
    for (const forbidden of ['<script', '<style', '<image', 'foreignObject', 'onload=', '<text']) {
      assert.equal(svg.includes(forbidden), false, `docs/${image[1]} 不应包含 ${forbidden}`)
    }
  }
})

/** 图标缺失时 Plugin Manager 会退回默认图；尺寸/引用错了同样不显示，所以这里挡一道。 */
test('icon.svg 是 36×36 的自包含 SVG', async () => {
  const { size } = await stat(new URL('../icon.svg', import.meta.url))
  assert.ok(size < 256 * 1024, `icon.svg 超过 256 KiB：${size}`)
  const svg = await readFile(new URL('../icon.svg', import.meta.url), 'utf8')
  assert.match(svg, /width="36"\s+height="36"/)
  assert.match(svg, /viewBox="0 0 36 36"/)
  for (const forbidden of ['<script', '<style', '<image', 'foreignObject', 'onload=', '<text']) {
    assert.equal(svg.includes(forbidden), false, `icon.svg 不应包含 ${forbidden}`)
  }
  // 渐变/mask id 以 session-bin- 前缀命名，内联到页面时不会撞车。
  const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1])
  assert.ok(ids.length > 0)
  for (const id of ids) assert.match(id, /^session-bin-/)
  for (const ref of [...svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1])) {
    assert.equal(ids.includes(ref), true, `引用了不存在的 id：${ref}`)
  }
})

test('cordis.patch.yml 插入自己这一行', async () => {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(text, /- insert:/)
  assert.match(text, /id: session-bin/)
  assert.match(text, /name: dsh-session-bin/)
})
