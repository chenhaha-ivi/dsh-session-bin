#!/usr/bin/env node
/**
 * 从已安装的 DSH 里提取 `dsh/` 运行时，用于**隔离实例**自测（不碰 desktop profile）。
 *
 * 跑法：node scripts/extract-runtime.mjs [--app "/Applications/DeepSeek Harness.app"] [--out .test-tmp/runtime]
 * 只读 app.asar（真机装的应用），把文件写到工作区里。提取后可以：
 *
 *   DSH_HOME="$PWD/.test-tmp/live-home" node .test-tmp/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
 *     --profile web --port 56832 --no-open
 */
import { copyFile, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const app = resolve(flag('app', '/Applications/DeepSeek Harness.app'))
const out = resolve(flag('out', join(process.cwd(), '.test-tmp', 'runtime')))
const asar = join(app, 'Contents', 'Resources', 'app.asar')
const unpacked = asar + '.unpacked'

const handle = await open(asar, 'r')
const prefix = Buffer.alloc(16)
await handle.read(prefix, 0, 16, 0)
const headerSize = prefix.readUInt32LE(4)
const jsonSize = prefix.readUInt32LE(12)
const headerJson = Buffer.alloc(jsonSize)
await handle.read(headerJson, 0, jsonSize, 16)
const tree = JSON.parse(headerJson.toString('utf8'))
const base = 8 + headerSize

const entries = []
const walk = (node, path) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const next = path === '' ? name : `${path}/${name}`
    if (child.files !== undefined) walk(child, next)
    else if (next.startsWith('dsh/')) entries.push({ path: next, size: child.size, offset: child.offset, unpacked: child.unpacked === true })
  }
}
walk(tree, '')

let extracted = 0
for (const entry of entries) {
  const destination = join(out, entry.path)
  await mkdir(dirname(destination), { recursive: true })
  if (entry.unpacked === true) {
    await copyFile(join(unpacked, entry.path), destination)
  } else {
    const buffer = Buffer.alloc(entry.size)
    await handle.read(buffer, 0, entry.size, base + Number(entry.offset))
    await writeFile(destination, buffer)
  }
  extracted += 1
}
await handle.close()
console.log(`extracted ${extracted} files -> ${join(out, 'dsh')}`)
