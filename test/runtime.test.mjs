import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime } from '../src/host/runtime.js'
import { BinError } from '../src/host/trash.js'

test('定位不到会话存储根时返回稳定错误码', () => {
  const saved = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    const runtime = createRuntime({ ctx: {}, registry: {}, sessionsRoot: () => undefined })
    assert.throws(
      () => runtime.requireSessionsRoot(),
      (error) => error instanceof BinError && error.code === 'session-bin/no-sessions-root',
    )
  } finally {
    if (saved !== undefined) process.env.DSH_HOME = saved
  }
})
