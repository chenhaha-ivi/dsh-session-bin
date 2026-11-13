/**
 * 测试用的假会话持久化：实现本插件真正用到的那一小撮 API
 * （open/read、create/append/flush/close、stat、list），并把「物化」写成
 * 真实目录 + 一行 header 文件，好让搬移事务里的路径判断生效。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeSegment, projectKey } from '../../src/host/paths.js'

/** 深拷贝（事件都是纯 JSON）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 领域错误：name 与真实后端一致，插件靠它判断。 */
function namedError(name, message) {
  const error = new Error(message)
  error.name = name
  return error
}

/**
 * @param {{root: string, failCreate?: boolean}} options
 */
export function createFakePersistence(options) {
  const root = options.root
  const configuredSize = options.sizeBytes
  const failCreate = options.failCreate === true
  const headers = new Map()
  const events = new Map()
  const inherited = new Map()
  const owners = new Set()
  const materialized = new Set()

  /** 把一条会话写成真实目录：第一行 header，其余是已提交事件（方便从磁盘重建）。 */
  async function materialize(header) {
    const dir = join(root, projectKey(header.cwd), encodeSegment(header.id))
    await mkdir(dir, { recursive: true })
    const lines = [JSON.stringify(header), ...(events.get(header.id) ?? []).map((event) => JSON.stringify(event))]
    await writeFile(join(dir, 'session.v4.jsonl'), lines.join('\n') + '\n', 'utf8')
    materialized.add(header.id)
  }

  const service = {
    root,
    /** 测试直读。 */
    headers,
    events,
    owners,
    materialized,

    /** 预置一条已物化的会话。 */
    seed(header, seededEvents = []) {
      headers.set(header.id, { ...header })
      events.set(header.id, clone(seededEvents))
      inherited.set(header.id, header.isSeeded === true ? seededEvents.length : 0)
      materialized.add(header.id)
    },

    async open(id, access) {
      const header = headers.get(id)
      if (header === undefined) throw namedError('SessionPersistenceNotFoundError', `no session ${id}`)
      if (access === 'write') {
        if (owners.has(id)) throw namedError('SessionAlreadyOwnedError', `session ${id} is already owned`)
        owners.add(id)
      }
      let closed = false
      return {
        header,
        inheritedEventCount: inherited.get(id) ?? 0,
        async read() {
          if (closed) throw namedError('SessionHandleClosedError', 'handle is closed')
          return { eventState: 'detached', events: clone(events.get(id) ?? []) }
        },
        async append(batch) {
          if (closed) throw namedError('SessionHandleClosedError', 'handle is closed')
          const current = events.get(id) ?? []
          const base = current.length
          batch.forEach((event, index) => {
            if (event.seq !== base + index) throw new Error(`append seq mismatch: expected ${base + index}, got ${event.seq}`)
            current.push(clone(event))
          })
          events.set(id, current)
        },
        async flush() {
          if (closed) throw namedError('SessionHandleClosedError', 'handle is closed')
          await materialize(headers.get(id))
        },
        async close() {
          closed = true
          if (access === 'write') owners.delete(id)
        },
      }
    },

    async create(header, createOptions) {
      if (failCreate) throw new Error('create refused (test)')
      if (headers.has(header.id)) {
        // 真实后端只认磁盘上还能找到的日志；源目录已经被 park 走时，这个 id 是可复用的。
        const existing = headers.get(header.id)
        const dir = join(root, projectKey(existing.cwd), encodeSegment(header.id))
        if (existsSync(dir)) throw namedError('SessionAlreadyExistsError', `session ${header.id} already exists`)
        headers.delete(header.id)
        events.delete(header.id)
        inherited.delete(header.id)
        materialized.delete(header.id)
      }
      const stored = clone(header)
      headers.set(stored.id, stored)
      events.set(stored.id, [])
      inherited.set(stored.id, createOptions?.inheritedEventCount ?? 0)
      owners.add(stored.id)
      let closed = false
      return {
        header: stored,
        async append(batch) {
          if (closed) throw namedError('SessionHandleClosedError', 'handle is closed')
          const current = events.get(stored.id) ?? []
          const base = current.length
          batch.forEach((event, index) => {
            if (event.seq !== base + index) throw new Error(`append seq mismatch: expected ${base + index}, got ${event.seq}`)
            current.push(clone(event))
          })
          events.set(stored.id, current)
        },
        async flush() {
          if (closed) throw namedError('SessionHandleClosedError', 'handle is closed')
          await materialize(stored)
        },
        async close() {
          closed = true
          owners.delete(stored.id)
        },
      }
    },

    async stat(id) {
      const header = headers.get(id)
      if (header === undefined) return undefined
      return {
        header,
        eventCount: (events.get(id) ?? []).length,
        sizeBytes: typeof configuredSize === 'number' ? configuredSize : undefined,
      }
    },

    async list() {
      return [...headers.values()].map((header) => ({ header }))
    },
  }
  return service
}


/**
 * 从磁盘重建假持久化：扫描 `<root>/<project>/<session>/` 下的 jsonl，
 * 第一行当 header、其余当事件。崩溃进程留下的世界靠它还原。
 * @param {string} root 会话存储根。
 */
export async function loadPersistenceFromDisk(root) {
  const service = createFakePersistence({ root })
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return service
  }
  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith('_')) continue
    let sessions
    try {
      sessions = await readdir(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(root, project.name, session.name)
      let files
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      const log = files.find((name) => name.endsWith('.jsonl'))
      if (log === undefined) continue
      try {
        const lines = (await readFile(join(dir, log), 'utf8')).split('\n').filter((line) => line.trim() !== '')
        if (lines.length === 0) continue
        const header = JSON.parse(lines[0])
        const sessionEvents = lines.slice(1).map((line) => JSON.parse(line))
        service.seed(header, sessionEvents)
      } catch {
        // 半截文件：跳过，测试会显式断言。
      }
    }
  }
  return service
}
