import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 拖拽逻辑的单测：真实事件顺序（dragstart → dragover → drop）跑在假 DOM 上。
 * 只验证状态机与载荷，不验证浏览器真的开始拖拽（那属于 M4 真机验收）。
 */

let loadCounter = 0

async function loadClient() {
  const captured = {}
  const listeners = new Map()
  globalThis.window = { __ModuleLoader__: { load(definition) { captured.definition = definition } } }
  globalThis.document = {
    createElement() {
      return { textContent: '', attributes: {}, remove() {}, setAttribute(name, value) { this.attributes[name] = value } }
    },
    head: { appendChild() {} },
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type) { listeners.delete(type) },
  }
  const React = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    Fragment: {},
  }
  loadCounter += 1
  await import(`../client.js?drag=${loadCounter}`)
  const exported = captured.definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
  return { exported, listeners }
}

/** 最小 DOM 节点：行键、父子、后代查询、classList。 */
function makeNode(attributes = {}) {
  const node = {
    attributes,
    children: [],
    parentNode: null,
    classList: {
      values: new Set(),
      add(name) { this.values.add(name) },
      remove(name) { this.values.delete(name) },
      contains(name) { return this.values.has(name) },
      [Symbol.iterator]() { return this.values[Symbol.iterator]() },
    },
    getAttribute(name) { return this.attributes[name] ?? null },
    append(child) {
      child.parentNode = node
      node.children.push(child)
      return child
    },
    contains(other) {
      let current = other
      while (current !== null && current !== undefined) {
        if (current === node) return true
        current = current.parentNode
      }
      return false
    },
    querySelectorAll(selector) {
      const prefix = /^\[data-row-key\^="([^"]*)"\]$/.exec(selector)?.[1] ?? null
      const found = []
      const walk = (element) => {
        for (const child of element.children) {
          const key = child.getAttribute('data-row-key') ?? ''
          if (prefix === null || key.startsWith(prefix)) found.push(child)
          walk(child)
        }
      }
      walk(node)
      return found
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] ?? null
    },
  }
  return node
}

/** 一个工作区分组：文件夹行 + 会话行。 */
function makeGroup(workspaceId, sessionIds) {
  const group = makeNode()
  group.append(makeNode({ 'data-row-key': `workspace:${workspaceId}` }))
  for (const sessionId of sessionIds) group.append(makeNode({ 'data-row-key': `session:${sessionId}` }))
  return group
}

function events() {
  const calls = []
  return {
    track(event, target) {
      const record = {
        target,
        dataTransfer: {},
        defaultPrevented: false,
        stopped: false,
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.stopped = true },
      }
      calls.push(record)
      return record
    },
    calls,
  }
}

function fakeCtx() {
  const dictionary = {}
  return {
    get: () => undefined,
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(namespace, dictionaries) { Object.assign(dictionary, dictionaries.zh) },
      bind() { return (key) => dictionary[key] ?? key },
    },
    slots: {
      inject(name, factory) { factory() },
      register() { return () => {} },
    },
  }
}

test('sessionIdOfNode 从嵌套节点找到会话 id；工作区行不算', async () => {
  const { exported } = await loadClient()
  const group = makeGroup('ws-1', ['session-9'])
  const nested = makeNode()
  group.children[1].append(nested)
  assert.equal(exported.__drag.sessionIdOfNode(nested), 'session-9')
  assert.equal(exported.__drag.sessionIdOfNode(group.children[0]), null)
  assert.equal(exported.__drag.sessionIdOfNode(group), null)
})

test('workspaceGroupOf 只认「恰好含一个工作区行」的祖先', async () => {
  const { exported } = await loadClient()
  const tree = makeNode()
  const first = tree.append(makeGroup('ws-1', ['session-1']))
  const second = tree.append(makeGroup('ws-2', ['session-2']))
  assert.equal(exported.__drag.workspaceGroupOf(first.children[1]).workspaceId, 'ws-1')
  assert.equal(exported.__drag.workspaceGroupOf(second.children[1]).workspaceId, 'ws-2')
  assert.equal(exported.__drag.workspaceGroupOf(first.children[0]).node, first)
  assert.equal(exported.__drag.workspaceGroupOf(tree), null, '整棵列表含多个工作区行，不接管')
})

test('dragstart 记住来源；跨组 dragover 才接管并高亮；drop 调 relocate', async () => {
  const { exported, listeners } = await loadClient()
  const ctx = fakeCtx()
  exported.apply(ctx)
  assert.equal(typeof listeners.get('dragstart'), 'function')
  assert.equal(typeof listeners.get('drop'), 'function')

  const tree = makeNode()
  const source = tree.append(makeGroup('ws-1', ['session-1']))
  const target = tree.append(makeGroup('ws-2', ['session-2']))
  const sessionRow = source.children[1]
  const targetSessionRow = target.children[1]
  const event = events()

  listeners.get('dragstart')(event.track('dragstart', sessionRow))
  const sameGroupDragOver = event.track('dragover', sessionRow)
  listeners.get('dragover')(sameGroupDragOver)
  assert.equal(sameGroupDragOver.defaultPrevented, false, '自己分组完全让路')
  listeners.get('dragover')(event.track('dragover', targetSessionRow))
  assert.equal(event.calls.at(-1).defaultPrevented, true)
  assert.equal(event.calls.at(-1).stopped, true)
  assert.equal(target.classList.contains('wsbin-drop-target'), false, '会话行上用插入线，不再叠虚线框')
  assert.equal(source.classList.contains('wsbin-drop-target'), false)
  assert.equal(targetSessionRow.classList.contains('wsbin-drop-after'), true, '落在目标会话行上要有插入线')

  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true, value: { applied: 'moved' } }) }
  }
  listeners.get('drop')(event.track('drop', targetSessionRow))
  assert.equal(event.calls.at(-1).defaultPrevented, true)
  assert.equal(target.classList.contains('wsbin-drop-target'), false, '投放后清除高亮')
  assert.equal(targetSessionRow.classList.contains('wsbin-drop-after'), false, '投放后清除插入线')
  await new Promise((settle) => setTimeout(settle, 0))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.endpoint, 'relocate')
  assert.deepEqual(requests[0].body.payload, { sessionId: 'session-1', targetWorkspaceId: 'ws-2' })
  assert.equal(exported.__stores.toastStore.get(), null, '成功搬运不再弹提示')
})

test('跨组 dragover 会清掉官方残留的蓝色插入线', async () => {
  const { exported, listeners } = await loadClient()
  exported.apply(fakeCtx())
  const tree = makeNode()
  const source = tree.append(makeGroup('ws-1', ['session-1']))
  const target = tree.append(makeGroup('ws-2', ['session-2']))
  const nativeRow = makeNode({ 'data-row-key': 'session:session-1' })
  nativeRow.classList.add('JoiKIa_dropAfter')
  globalThis.document.querySelectorAll = () => [nativeRow]

  listeners.get('dragstart')(events().track('dragstart', source.children[1]))
  listeners.get('dragover')(events().track('dragover', target.children[1]))
  assert.equal(nativeRow.classList.contains('JoiKIa_dropAfter'), false, '官方残留线要被清掉')
})

test('落在目标工作区目录（标题行）上不画插入线', async () => {
  const { exported, listeners } = await loadClient()
  exported.apply(fakeCtx())
  const tree = makeNode()
  const source = tree.append(makeGroup('ws-1', ['session-1']))
  const target = tree.append(makeGroup('ws-2', ['session-2']))
  const targetWorkspaceRow = target.children[0]
  const targetSessionRow = target.children[1]
  const event = events()
  listeners.get('dragstart')(event.track('dragstart', source.children[1]))
  listeners.get('dragover')(event.track('dragover', targetWorkspaceRow))
  assert.equal(target.classList.contains('wsbin-drop-target'), true, '分组仍然高亮')
  assert.equal(targetSessionRow.classList.contains('wsbin-drop-after'), false, '标题行上不画线')
  assert.equal(targetSessionRow.classList.contains('wsbin-drop-before'), false)
})

test('叉到目标会话行后按落点写 manual order', async () => {
  const { exported, listeners } = await loadClient()
  const calls = []
  const ctx = fakeCtx()
  ctx.get = (name) => {
    if (name === 'uiWorkspace') return { view: { setSessionOrder: (key, order) => calls.push([key, order]) } }
    if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-2', sessionIds: ['session-2', 'session-3'] }] }) } }
    return undefined
  }
  exported.apply(ctx)
  const tree = makeNode()
  const source = tree.append(makeGroup('ws-1', ['session-1']))
  const target = tree.append(makeGroup('ws-2', ['session-2', 'session-3']))
  globalThis.document.querySelectorAll = (selector) => (selector.includes('workspace:') ? [target.children[0]] : [])
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, value: { applied: 'moved' } }) })

  const event = events()
  listeners.get('dragstart')(event.track('dragstart', source.children[1]))
  listeners.get('dragover')(event.track('dragover', target.children[1])) // session-2, after
  listeners.get('drop')(event.track('drop', target.children[1]))
  await new Promise((settle) => setTimeout(settle, 0))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'ws-2')
  assert.deepEqual(calls[0][1], ['session-2', 'session-1', 'session-3'])
})

test('落在整棵列表上不接管', async () => {
  const { exported, listeners } = await loadClient()
  exported.apply(fakeCtx())
  const tree = makeNode()
  tree.append(makeGroup('ws-1', ['session-1']))
  const target = tree.append(makeGroup('ws-2', ['session-2']))

  listeners.get('dragstart')({ target: tree.children[0].children[1], dataTransfer: {} })
  const onTree = { target: tree, dataTransfer: {}, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true } }
  listeners.get('dragover')(onTree)
  assert.equal(onTree.prevented ?? false, false)
  assert.equal(target.classList.contains('wsbin-drop-target'), false)
})
