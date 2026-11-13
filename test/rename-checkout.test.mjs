import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/rename-checkout.mjs', import.meta.url))
const base = new URL('../.test-tmp/rename-checkout-', import.meta.url).pathname + Math.random().toString(16).slice(2, 8)

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 造一个「旧布局」：仓库叫 dsh-workspace-bin，profile 还指着旧包名。 */
async function fixture() {
  const root = join(base, 'old', 'dsh-workspace-bin')
  const profile = join(base, 'profile')
  await mkdir(root, { recursive: true })
  await mkdir(profile, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-session-bin' }, null, 2) + '\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-structured': '1.0.14', 'dsh-workspace-bin': `link:${root}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-workspace-bin', 'dsh-structured'] } },
  }, null, 2) + '\n')
  return { root, profile }
}

test('升级脚本：预演不动盘，--apply 才改名并换 profile 包名', async () => {
  const { root, profile } = await fixture()
  try {
    const dry = await run(process.execPath, [script, '--root', root, '--profile', profile])
    assert.match(dry.stdout, /预演结束/)
    assert.equal(await exists(root), true)
    assert.equal(await exists(join(profile, 'package.json')), true)

    const applied = await run(process.execPath, [script, '--root', root, '--profile', profile, '--apply', '--skip-install'])
    assert.match(applied.stdout, /目录已改名/)
    const target = join(base, 'old', 'dsh-session-bin')
    assert.equal(await exists(root), false)
    assert.equal(await exists(target), true)

    const next = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.equal(next.dependencies['dsh-workspace-bin'], undefined)
    assert.equal(next.dependencies['dsh-session-bin'], `link:${target}`)
    assert.deepEqual(next.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-session-bin', 'dsh-structured'])
    const backup = join(profile, 'package.json.bak-before-dsh-session-bin')
    assert.equal(await exists(backup), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('升级脚本：目标目录已存在时拒绝执行', async () => {
  const { root, profile } = await fixture()
  try {
    await mkdir(join(base, 'old', 'dsh-session-bin'), { recursive: true })
    await assert.rejects(
      run(process.execPath, [script, '--root', root, '--profile', profile, '--apply', '--skip-install']),
      (error) => /已经存在/.test(String(error.stderr)),
    )
    assert.equal(await exists(root), true, '拒绝时不该动旧目录')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
