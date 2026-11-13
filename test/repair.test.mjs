import assert from 'node:assert/strict'
import test from 'node:test'
import { findDuplicates, planRepair } from '../scripts/repair-duplicates.mjs'

test('findDuplicates 找出被两个工作区同时记账的会话', () => {
  const state = {
    tables: {
      workspaces: {
        'ws-a': { path: '/a', sessionIds: ['s-1', 's-2'] },
        'ws-b': { path: '/b', sessionIds: ['s-2'] },
        'ws-c': { path: '/c', sessionIds: [] },
      },
    },
  }
  const duplicates = findDuplicates(state)
  assert.deepEqual([...duplicates.keys()], ['s-2'])
  assert.deepEqual(duplicates.get('s-2').sort(), ['ws-a', 'ws-b'])
})

test('planRepair 保留归属工作区、只摘除其余记录', () => {
  const state = {
    tables: {
      workspaces: {
        'ws-a': { path: '/a', sessionIds: ['s-1', 's-2'] },
        'ws-b': { path: '/b', sessionIds: ['s-2'] },
      },
    },
  }
  const { repairs, unresolved } = planRepair(state, new Map([['s-2', 'ws-b']]))
  assert.deepEqual(unresolved, [])
  assert.deepEqual(repairs, [{ sessionId: 's-2', keep: 'ws-b', remove: ['ws-a'] }])
})

test('找不到归属时列进 unresolved，不瞎删', () => {
  const state = {
    tables: {
      workspaces: {
        'ws-a': { path: '/a', sessionIds: ['s-1'] },
        'ws-b': { path: '/b', sessionIds: ['s-1'] },
      },
    },
  }
  const { repairs, unresolved } = planRepair(state, new Map())
  assert.deepEqual(repairs, [])
  assert.deepEqual(unresolved, ['s-1'])
})
