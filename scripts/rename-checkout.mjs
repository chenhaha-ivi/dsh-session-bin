#!/usr/bin/env node
/**
 * 改名的一次性升级脚本：把仓库目录 `dsh-workspace-bin` 改成 `dsh-session-bin`，
 * 同时把 profile 里的依赖与 `dsh.profile.bundles` 换到新包名。
 *
 * 为什么不能在会话里顺手做：DSH 的工作区根就是仓库目录本身，运行中改名会让
 * 当前会话的工作区路径、文件沙箱和 profile 软链同时失效。所以这一步必须在 DSH 之外跑：
 *
 *   # 先退出 DSH，然后在 Terminal 里（别停在仓库目录里）
 *   cd ~
 *   node ~/Documents/dsh-workspace-bin/scripts/rename-checkout.mjs          # 预演，只打印计划
 *   node ~/Documents/dsh-workspace-bin/scripts/rename-checkout.mjs --apply  # 真改
 *
 * 执行顺序：备份 profile/package.json → 目录改名 → 改依赖与 bundles → pnpm install。
 * 回收站数据迁移**不在这里**：新版插件首次启动时会把 `<DSH_HOME>/workspace-bin`
 * 改名为 `<DSH_HOME>/session-bin`（见 src/host/trash.js 的 migrateLegacyRoot）。
 *
 * 参数：
 *   --apply          真改（缺省只预演）
 *   --root <dir>     要改名的仓库目录（缺省：本脚本所在仓库）
 *   --profile <dir>  profile 目录（缺省：$DSH_PROFILE_DIR 或 ~/.dsh/profiles/desktop）
 *   --skip-install   跳过 pnpm install（预演或手工装依赖时用）
 */
import { spawnSync } from 'node:child_process'
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OLD_NAME = 'dsh-workspace-bin'
const NEW_NAME = 'dsh-session-bin'
const OLD_PLUGIN_ID = 'workspace-bin'
const NEW_PLUGIN_ID = 'session-bin'

/** 解析 `--flag value`。 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const apply = process.argv.includes('--apply')
const skipInstall = process.argv.includes('--skip-install')
const here = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(flag('root', here))
const target = join(dirname(root), NEW_NAME)
const profileDir = resolve(flag('profile', process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')))

/** 控制台前缀，便于和 pnpm 输出区分。 */
const say = (message) => console.log(`[rename] ${message}`)
const plan = (message) => console.log(`[rename] ${apply ? '做' : '将做'}：${message}`)

/** 读 JSON；读不到/不是对象都抛。 */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** 路径存在吗。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 退出前把计划交代清楚。 */
function abort(message) {
  console.error(`[rename] 中止：${message}`)
  process.exit(1)
}

// ── 1. 检查仓库目录 ────────────────────────────────────────────────────────────

if (basename(root) !== OLD_NAME && basename(root) !== NEW_NAME) {
  abort(`仓库目录叫 ${basename(root)}，既不是 ${OLD_NAME} 也不是 ${NEW_NAME}；用 --root 指清楚`)
}
const manifest = await readJson(join(root, 'package.json')).catch(() => undefined)
if (manifest?.name !== NEW_NAME) {
  abort(`${join(root, 'package.json')} 的 name 不是 ${NEW_NAME}，不像改名后的仓库`)
}
const alreadyRenamed = basename(root) === NEW_NAME
if (!alreadyRenamed && (await exists(target))) {
  abort(`${target} 已经存在；先确认它是什么，别覆盖`)
}
if (process.cwd() === root || process.cwd().startsWith(root + '/')) {
  say('提醒：你正站在要改名的目录里。脚本能跑完，但跑完这个 shell 的 cwd 会失效，记得 cd 到新目录。')
}

// ── 2. 规划 profile 改动 ──────────────────────────────────────────────────────

const profilePath = join(profileDir, 'package.json')
const profile = await readJson(profilePath).catch(() => undefined)
if (profile === undefined) abort(`读不到 profile 清单 ${profilePath}；用 --profile 指清楚`)

const dependencies = profile.dependencies ?? {}
const bundles = profile?.dsh?.profile?.bundles ?? []
const hadDependency = dependencies[OLD_NAME] !== undefined || dependencies[NEW_NAME] !== undefined
const bundleIndex = bundles.indexOf(OLD_NAME)
const linkSpec = `link:${alreadyRenamed ? root : target}`

plan(`把仓库目录 ${root} 改名成 ${alreadyRenamed ? '（已是新名字，跳过）' : target}`)
plan(`profile 依赖：${hadDependency ? `${OLD_NAME} → ` : '（没装过，补上）'}${NEW_NAME} = ${linkSpec}`)
plan(`profile bundles：${bundleIndex >= 0 ? `${OLD_NAME} → ${NEW_NAME}` : `补上 ${NEW_NAME}`}`)
plan(`在 ${profileDir} 跑 pnpm install${skipInstall ? '（--skip-install 已跳过）' : ''}`)
if (alreadyRenamed && !hadDependency) abort('目录已是新名字，profile 里也没有这个包：没什么可做的')

if (!apply) {
  say('预演结束。确认没问题后加 --apply 再跑一次（跑之前先退出 DSH）。')
  process.exit(0)
}

// ── 3. 备份 profile 清单 ──────────────────────────────────────────────────────

let backup = `${profilePath}.bak-before-${NEW_NAME}`
if (await exists(backup)) backup = `${backup}.${Date.now()}`
await copyFile(profilePath, backup)
say(`已备份 profile 清单：${backup}`)

// ── 4. 目录改名 ──────────────────────────────────────────────────────────────

if (!alreadyRenamed) {
  await rename(root, target)
  say(`目录已改名：${root} → ${target}`)
}

// ── 5. 改写 profile 清单 ─────────────────────────────────────────────────────

const nextDependencies = { ...dependencies }
delete nextDependencies[OLD_NAME]
nextDependencies[NEW_NAME] = linkSpec
profile.dependencies = nextDependencies

const nextBundles = [...bundles]
const oldIndex = nextBundles.indexOf(OLD_NAME)
if (oldIndex >= 0) nextBundles[oldIndex] = NEW_NAME
if (!nextBundles.includes(NEW_NAME)) nextBundles.push(NEW_NAME)
profile.dsh = { ...profile.dsh, profile: { ...profile.dsh?.profile, bundles: nextBundles } }
await writeFile(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf8')
say(`profile 清单已改写：${profilePath}`)

// ── 6. 装依赖 ────────────────────────────────────────────────────────────────

if (!skipInstall) {
  const result = spawnSync('pnpm', ['install'], { cwd: profileDir, stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    console.error('[rename] pnpm install 失败。别慌，按顺序手工补：')
    console.error(`  cd ${profileDir}`)
    console.error(`  pnpm remove ${OLD_NAME} || true`)
    console.error(`  pnpm add ${linkSpec}`)
    console.error('回收站数据不受影响；装好再启动 DSH。')
    process.exit(2)
  }
}

// ── 7. 收尾提示 ──────────────────────────────────────────────────────────────

say('完成。接下来：')
say(`  1. cd ${target} && node scripts/check-profile.mjs   # 三项都应 OK`)
say('  2. 启动 DSH；首次启动会自动把 ~/.dsh/workspace-bin 改名成 session-bin')
say('  3. 在 DSH 里把新目录加为工作区，旧工作区条目（指向老路径）可以删掉')
console.warn('[rename] 注意：这个工作区里已有会话的 cwd 仍记着旧路径，重命名后会落到「找不到目录」；')
console.warn('[rename] 要保留它们，在 DSH 里用插件的跨区移动把会话搬到新工作区后再删旧条目。')
