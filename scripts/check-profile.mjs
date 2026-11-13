#!/usr/bin/env node
/**
 * 只读预检：profile 有没有装这份插件、链接指到哪、engines 匹配不匹配。
 *
 * 跑法：node scripts/check-profile.mjs [profileDir]
 * 默认 profile：$DSH_PROFILE_DIR，否则 ~/.dsh/profiles/desktop。
 * 退出码 0 = 看起来可以重启验收；1 = 有阻断项。
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-session-bin'
const here = fileURLToPath(new URL('..', import.meta.url))

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

const profileDir = resolve(process.argv[2] ?? process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'))
const problems = []
const report = { profileDir, packageDir: here, checks: {} }

try {
  const profile = await readJson(join(profileDir, 'package.json'))
  const bundles = profile?.dsh?.profile?.bundles ?? []
  report.checks.bundles = bundles.includes(PACKAGE)
  report.checks.dependency = (profile?.dependencies ?? {})[PACKAGE] !== undefined
  if (!report.checks.bundles) problems.push(`package.json 的 dsh.profile.bundles 里没有 ${PACKAGE}`)

  const linked = join(profileDir, 'node_modules', PACKAGE)
  try {
    const info = await lstat(linked)
    report.checks.linked = info.isSymbolicLink()
    if (info.isSymbolicLink()) {
      report.checks.linkTarget = await realpath(linked)
      if (resolve(report.checks.linkTarget) !== resolve(here)) {
        problems.push(`node_modules/${PACKAGE} 指向 ${report.checks.linkTarget}，不是 ${here}`)
      }
    } else {
      const installed = await readJson(join(linked, 'package.json'))
      report.checks.installedCopy = `${installed.name}@${installed.version}`
      if (installed.name !== PACKAGE) problems.push(`node_modules/${PACKAGE} 里装的是 ${installed.name}`)
    }
  } catch {
    report.checks.linked = false
    problems.push(`node_modules/${PACKAGE} 不存在（先 pnpm add link:${here} 或 dsh plugin --profile <name> add ${PACKAGE}）`)
  }

  const plugin = await readJson(join(here, 'package.json'))
  report.engines = { node: plugin.engines?.node, dsh: plugin.engines?.dsh }
  if (plugin.engines?.dsh === undefined) problems.push('package.json 缺少 engines.dsh')
} catch (error) {
  problems.push(`读不了 profile：${error.message}`)
}

console.log(JSON.stringify(report, null, 2))
if (problems.length > 0) {
  console.error('\n阻断项：')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log('\n预检通过：可以重启 DSH 做真机验收（重启会中断当前会话）。')
