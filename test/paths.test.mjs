import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeSegment, groupByProjectKey, projectDirName, projectKey, projectKeyCollisions } from '../src/host/paths.js'

// 期望值来自 dsh-session-relocate/docs/DESIGN.md §projectKey（按算法手推，不是跑函数抄的）。
test('projectKey 与真实 DSH 目录名一致', () => {
  const cases = [
    ['D:\\示例\\A', '--D-~793A~4F8B-A--'],
    ['E:\\工作\\AI\\甲', '--E-~5DE5~4F5C-AI-~7532--'],
    ['E:/work/ws', '--E-work-ws--'],
    ['C:\\', '--C---'],
  ]
  for (const [cwd, expected] of cases) {
    assert.equal(projectKey(cwd), expected, cwd)
  }
})

test('projectKey 折叠连续分隔符、保留可读字符', () => {
  assert.equal(projectKey('/a//b'), '--a-b--')
  assert.equal(projectKey('/a-b'), '--a-b--')
  assert.equal(projectKey('/Users/me/code.dsh'), '--Users-me-code.dsh--')
})

test('projectKey 拒绝空路径', () => {
  assert.throws(() => projectKey(''), /empty project path/)
  assert.throws(() => projectKey(undefined), /empty project path/)
})

test('projectDirName 把无 cwd 的会话落到 _no-cwd', () => {
  assert.equal(projectDirName(undefined), '_no-cwd')
  assert.equal(projectDirName('/tmp/x'), projectKey('/tmp/x'))
})

test('encodeSegment 只对整段 . / .. 特殊处理', () => {
  assert.equal(encodeSegment('session-abc'), 'session-abc')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('😀'), '~D83D~DE00')
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

test('groupByProjectKey 找到有损映射的碰撞', () => {
  const groups = groupByProjectKey(['/a-b', '/a/b', '/other'])
  const collided = [...groups.entries()].filter(([, paths]) => paths.length > 1)
  assert.equal(collided.length, 1)
  assert.deepEqual(collided[0][1].sort(), ['/a-b', '/a/b'])
})

test('projectKeyCollisions 只报别的路径', () => {
  assert.deepEqual(projectKeyCollisions('/a-b', ['/a/b', '/other']), ['/a/b'])
  assert.deepEqual(projectKeyCollisions('/a-b', ['/a-b', '/other']), [])
  assert.deepEqual(projectKeyCollisions('/a-b', []), [])
})
