/**
 * DSH 会话存储的路径布局：`projectKey` 与 `encodeSegment`。
 *
 * 这两个算法是 `@deepseek-ai/dsh-session-persistence-jsonl` 内部行为的忠实移植。
 * 插件必须自己能算出目录名，才能在会话目录被搬走 / 搬回时让 DSH 仍然找得到日志，
 * 同时不 import 任何核心包（插件只通过 cordis 服务拿能力）。
 *
 * 移植正确性由 `test/paths.test.mjs` 用 DESIGN.md 里手推的真实样本比对。
 *
 * @module dsh-workspace-bin/paths
 */

/** 可以原样出现在路径段里的安全码元。 */
const SAFE_CODE_UNIT = /^[A-Za-z0-9._-]$/

/**
 * 把一个任意 UTF-16 字符串编码成安全的单段路径名（单射）。
 *
 * 安全码元原样保留；其余（含 `~` 本身）转成 `~XXXX`（大写十六进制，至少 4 位）。
 * `.` 与 `..` 整段特殊处理，避免路径穿越。
 *
 * @param {string} raw 待编码字符串，不可为空。
 * @returns {string} 安全的路径段。
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('cannot encode an empty path segment')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character !== '~' && SAFE_CODE_UNIT.test(character)) out += character
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * 由会话的 cwd 得到「项目目录」名。
 *
 * 分隔符（`/`、`\`、`:`）折叠成一个 `-`；不安全码元走 `~XXXX`；两端包 `--`；
 * 整体截断到 251 字符。这个映射**有意有损**（便于人肉浏览），
 * 所以 cwd 不同的会话仍靠 session id 区分。
 *
 * @param {string} cwd 会话的项目目录（绝对路径）。
 * @returns {string} 单个安全的项目目录名。
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cannot encode an empty project path')
  }
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const character = String.fromCharCode(code)
    if (character === '/' || character === '\\' || character === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (character !== '~' && SAFE_CODE_UNIT.test(character)) {
      readable += character
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const body = (readable.replace(/^-+/, '') || 'root').slice(0, 251)
  return '--' + body + '--'
}

/**
 * 一个 cwd 对应的项目目录名；没有 cwd 的会话落在 `_no-cwd`。
 *
 * @param {string | undefined} cwd
 * @returns {string}
 */
export function projectDirName(cwd) {
  return cwd === undefined ? '_no-cwd' : projectKey(cwd)
}

/**
 * 按 projectKey 给一组路径分组，用来发现「不同路径映射到同一个项目目录」的碰撞。
 *
 * projectKey 有损：`/a-b` 与 `/a/b` 都会得到 `--a-b--`。删工作区时若直接整目录
 * rename，就会把同目录下属于另一条路径的会话一起搬走 —— 所以搬之前必须问这一句。
 *
 * @param {Iterable<string>} paths 待检查的绝对路径（同一批工作区路径）。
 * @returns {Map<string, string[]>} projectKey → 落到同一键上的路径（含单元素组）。
 */
export function groupByProjectKey(paths) {
  const groups = new Map()
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) continue
    const key = projectKey(path)
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [path])
    else if (!bucket.includes(path)) bucket.push(path)
  }
  return groups
}

/**
 * 找出与 `path` 撞同一个 projectKey 的**其他**路径。
 *
 * @param {string} path 目标路径。
 * @param {Iterable<string>} otherPaths 其他工作区的路径。
 * @returns {string[]} 撞键的其他路径（不含 path 自己）。
 */
export function projectKeyCollisions(path, otherPaths) {
  const key = projectKey(path)
  const collisions = []
  for (const other of otherPaths) {
    if (typeof other !== 'string' || other.length === 0 || other === path) continue
    if (projectKey(other) === key) collisions.push(other)
  }
  return collisions
}
