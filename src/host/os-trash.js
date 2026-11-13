/**
 * 把路径丢进**操作系统**的回收站（macOS 废纸篓 / Windows 回收站 / Linux 回收站）。
 *
 * 优先走 Electron 的 `shell.trashItem`：桌面端宿主跑在 Electron 主进程里，它一次
 * 覆盖三个平台，跨卷、权限、放回原处都由系统处理。拿不到 Electron（例如独立的
 * `dsh web`）时，macOS 退化成 rename 到 `~/.Trash`，其余平台直接报错——绝不
 * `rm -rf` 冒充回收站。
 *
 * @module dsh-workspace-bin/os-trash
 */

import { createRequire } from 'node:module'
import { lstat, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const nodeRequire = createRequire(import.meta.url)

/** 取 Electron 的 shell；不在 Electron 里就返回 undefined。 */
function defaultElectronShell() {
  try {
    const electron = nodeRequire('electron')
    return electron !== null && typeof electron === 'object' ? electron.shell : undefined
  } catch {
    return undefined
  }
}

/**
 * macOS 的同卷退路：rename 进 `~/.Trash`（重名加时间后缀）。
 * @param {string} path
 * @param {{home: string, statOf: Function, renameOf: Function}} deps
 * @returns {Promise<{via: string, target: string}>}
 */
async function moveIntoMacTrash(path, deps) {
  const { home, statOf, renameOf } = deps
  const trashDir = join(home, '.Trash')
  const info = await statOf(path)
  let trashInfo
  try {
    trashInfo = await statOf(trashDir)
  } catch {
    throw new Error(`the macOS Trash folder is not available at ${trashDir}`)
  }
  if (info.dev !== trashInfo.dev) {
    throw new Error(`refusing a cross-volume move into ${trashDir}`)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = attempt === 0 ? '' : attempt === 1 ? ` ${stamp}` : ` ${stamp}-${attempt}`
    const target = join(trashDir, `${basename(path)}${suffix}`)
    try {
      await lstat(target)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        await renameOf(path, target)
        return { via: 'macos-trash', target }
      }
      throw error
    }
  }
  throw new Error(`could not find a free name in ${trashDir}`)
}

/**
 * 把一条路径移进系统回收站。
 *
 * @param {string} path 要移走的绝对路径。
 * @param {object} [options]
 * @param {string} [options.platform] 平台（测试注入）。
 * @param {string} [options.home] 用户主目录（测试注入）。
 * @param {{trashItem?: Function}} [options.electronShell] Electron shell（测试注入）。
 * @param {(path: string) => Promise<any>} [options.stat] stat（测试注入）。
 * @param {(from: string, to: string) => Promise<void>} [options.rename] rename（测试注入）。
 * @returns {Promise<{via: string, target: string}>} 走的是哪条路径、最终落在哪。
 */
export async function trashPathToOs(path, options = {}) {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const statOf = options.stat ?? stat
  const renameOf = options.rename ?? rename

  const failures = []

  // macOS：先自己 rename 进 ~/.Trash。目标路径确定、Finder 一定看得见；
  // 跨卷（EXDEV）或权限问题再交给 Electron 的 shell.trashItem。
  if (platform === 'darwin') {
    try {
      return await moveIntoMacTrash(path, { home, statOf, renameOf })
    } catch (error) {
      failures.push(error)
    }
  }

  const shell = options.electronShell !== undefined ? options.electronShell : defaultElectronShell()
  if (shell !== null && shell !== undefined && typeof shell.trashItem === 'function') {
    try {
      await shell.trashItem(path)
      return { via: 'electron', target: path }
    } catch (error) {
      failures.push(error)
    }
  }

  const detail = failures.length === 0
    ? ''
    : ` (${failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')})`
  throw new Error(`no OS trash implementation for platform ${JSON.stringify(platform)}${detail}`)
}
