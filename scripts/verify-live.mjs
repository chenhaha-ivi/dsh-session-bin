#!/usr/bin/env node
/**
 * 重启后的只读验活：确认 `/api/session-bin` 已经挂在正在跑的 DSH 上。
 *
 * 跑法：node scripts/verify-live.mjs [--url http://127.0.0.1:54821] [--token ...]
 * token 缺省从 ~/.dsh/dsh-web-auth.log 读（本机可读），先用它换浏览器 cookie，
 * 再 POST 一次 `list`。不写任何东西、不删任何条目。
 *
 * 退出码：0 = 路由已挂载且回答正常；1 = 没挂载/认证失败/回答异常。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 读 `--name value`。 */
function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const base = (flag('url', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:54821')).replace(/\/+$/, '')
const token = (() => {
  const given = flag('token', '')
  if (given !== '') return given
  try {
    const log = readFileSync(join(homedir(), '.dsh', 'dsh-web-auth.log'), 'utf8')
    return log.match(/token=([A-Za-z0-9._~-]+)/)?.[1] ?? ''
  } catch {
    return ''
  }
})()

if (token === '') {
  console.error('找不到启动 token：用 --token 传，或确认 ~/.dsh/dsh-web-auth.log 存在。')
  process.exit(1)
}

/** 用 token 换 cookie；不跟随重定向，因为 Set-Cookie 就在 302 上。 */
const exchange = await fetch(base + '/?token=' + encodeURIComponent(token), { redirect: 'manual' })
const cookies = typeof exchange.headers.getSetCookie === 'function'
  ? exchange.headers.getSetCookie()
  : [exchange.headers.get('set-cookie') ?? ''].filter((value) => value !== '')
if (cookies.length === 0) {
  console.error(`换 cookie 失败：HTTP ${exchange.status}`)
  process.exit(1)
}
const cookie = cookies.map((value) => value.split(';', 1)[0]).join('; ')

const response = await fetch(base + '/api/session-bin', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ endpoint: 'list', payload: {} }),
})
const text = await response.text()
let body
try {
  body = JSON.parse(text)
} catch {
  body = undefined
}

if (response.status === 404) {
  console.error('路由未挂载（404）：插件还没被加载，重启 DSH 后再试。')
  process.exit(1)
}
if (response.status === 401 || response.status === 403) {
  console.error(`认证被拒（HTTP ${response.status}）：token 可能过期，重启后再读一次日志。`)
  process.exit(1)
}
if (body?.ok !== true) {
  console.error(`路由回答了 HTTP ${response.status}，但信封不 ok：${text.slice(0, 300)}`)
  process.exit(1)
}
const value = body.value ?? {}
console.log(`OK  已挂载。回收站条目 ${Array.isArray(value.entries) ? value.entries.length : '?'} 个，损坏 ${Array.isArray(value.broken) ? value.broken.length : '?'} 个。`)
console.log(`    trashRoot: ${value.root ?? '(未返回)'}`)
