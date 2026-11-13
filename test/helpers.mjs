import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 所有测试写在 workspace 内的 .test-tmp，绝不碰真实 DSH home。 */
const BASE = fileURLToPath(new URL('../.test-tmp/', import.meta.url))

/**
 * 建一个一次性 fake DSH home。
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
export async function tempHome(prefix = 'home-') {
  await mkdir(BASE, { recursive: true })
  return await mkdtemp(join(BASE, prefix))
}

/**
 * 删掉 fake home（测试结束调用）。
 * @param {string} path
 */
export async function dispose(path) {
  await rm(path, { recursive: true, force: true })
}

/**
 * 一份合法的 workspace 类 manifest。
 * @param {Record<string, unknown>} [overrides]
 * @returns {object}
 */
export function workspaceManifest(overrides = {}) {
  return {
    version: 1,
    kind: 'workspace',
    createdAt: '2026-11-12T13:31:00.000Z',
    state: 'planned',
    workspace: {
      id: 'ws-1',
      path: '/tmp/ws',
      title: 'ws',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    projectKey: '--tmp-ws--',
    sessions: [{ id: 'session-1', title: 'hello', archived: false, pinned: false }],
    ...overrides,
  }
}
