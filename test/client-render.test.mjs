import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 轻量渲染冒烟：不实现 React 协调，只按函数组件递归展开 JSX 树。
 * 目的不是比对外观，而是抓「渲染时访问 undefined / hooks 顺序错」这类会白屏的错。
 */
let loadCounter = 0

async function loadClient() {
  const captured = {}
  globalThis.window = { __ModuleLoader__: { load(definition) { captured.definition = definition } } }
  globalThis.document = {
    createElement() {
      return { textContent: '', attributes: {}, remove() {}, setAttribute(name, value) { this.attributes[name] = value } }
    },
    head: { appendChild() {} },
  }
  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    Fragment: Symbol('Fragment'),
  }
  loadCounter += 1
  await import(`../client.js?render=${loadCounter}`)
  const exported = captured.definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
  return exported
}

/** 把组件树展开成普通节点树；文本原样保留。 */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(render).filter((child) => child !== null)
  if (typeof node === 'string' || typeof node === 'number') return node
  const { type, props } = node
  if (typeof type === 'function') return render(type(props ?? {}))
  return {
    type: typeof type === 'symbol' ? '#fragment' : String(type),
    props: props ?? {},
    children: render(props?.children ?? null),
  }
}

/** 收集树里的纯文本。 */
function texts(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  return texts(node.children)
}

/** 收集指定 className 的节点。 */
function findByClass(node, className) {
  if (Array.isArray(node)) return node.flatMap((child) => findByClass(child, className))
  if (node === null || node === undefined || typeof node !== 'object') return []
  const found = []
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) found.push(node)
  return found.concat(findByClass(node.children, className))
}

function fakeClientCtx() {
  const calls = { slots: [], menus: [], locales: [], effects: [] }
  return {
    calls,
    ctx: {
      get(name) {
        if (name !== 'contextMenus') return undefined
        return { register(definition) { calls.menus.push(definition); return () => {} } }
      },
      effect(fn, label) {
        calls.effects.push(label)
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      locale: {
        register(namespace, dictionaries) { calls.locales.push({ namespace, dictionaries }) },
        bind() { return (key) => key },
      },
      slots: {
        inject(name, factory) { factory(); return () => {} },
        register(definition) { calls.slots.push(definition); return () => {} },
      },
    },
  }
}

test('页脚按钮与回收站面板能渲染（空面板）', async () => {
  const exported = await loadClient()
  const { ctx, calls } = fakeClientCtx()
  exported.apply(ctx)

  const slot = (name) => calls.slots.find((entry) => entry.name === name)
  assert.notEqual(slot('sidebar.footer.action'), undefined)
  assert.notEqual(slot('shell.overlay'), undefined)
  // 注册项第二参数是组件，测试里直接拿不到；用工厂重跑一次拿到组件引用。
  const definitions = []
  const captureCtx = fakeClientCtx()
  captureCtx.ctx.slots.register = (definition, component) => {
    definitions.push({ definition, component })
    captureCtx.calls.slots.push(definition)
    return () => {}
  }
  exported.apply(captureCtx.ctx)
  const byName = new Map(definitions.map((entry) => [entry.definition.name, entry.component]))

  const footer = render(byName.get('sidebar.footer.action')({ t: (key) => key }))
  assert.equal(texts(footer).includes('bin.open'), true)
  assert.equal(findByClass(footer, 'wsbin-footer-action').length, 1, '页脚入口要带自适应宽度的类')

  exported.__stores.binStore.set(true)
  const panel = render(byName.get('shell.overlay')({ t: (key) => key }))
  assert.equal(findByClass(panel, 'wsbin-dialog').length, 1)
  assert.equal(texts(panel).includes('bin.title'), true)
  assert.equal(texts(panel).includes('bin.loading'), true)

  exported.__stores.binStore.set(false)
  exported.__stores.requestStore.set({ kind: 'session', sessionId: 'session-1', displayTitle: '演示会话' })
  const dialog = render(byName.get('shell.overlay')({ t: (key) => key }))
  assert.equal(texts(dialog).includes('dialog.title'), true)
  assert.equal(texts(dialog).includes('dialog.planning'), true)
  exported.__stores.requestStore.set(null)
})

test('运行中会话搬移确认框：点确认才发 relocate', async () => {
  const exported = await loadClient()
  const { ctx, calls } = fakeClientCtx()
  const definitions = []
  ctx.slots.register = (definition, component) => {
    definitions.push({ definition, component })
    calls.slots.push(definition)
    return () => {}
  }
  exported.apply(ctx)
  const byName = new Map(definitions.map((entry) => [entry.definition.name, entry.component]))
  exported.__stores.moveRequestStore.set({
    sessionId: 'session-1',
    targetWorkspaceId: 'ws-2',
    targetTitle: '目标工作区',
    insertion: { workspaceId: 'ws-2', anchorId: null, side: 'after' },
  })
  const overlay = render(byName.get('shell.overlay')({ t: (key) => key }))
  assert.equal(texts(overlay).includes('move.confirmTitle'), true)
  assert.equal(texts(overlay).includes('move.confirmAction'), true)
  const confirm = findByClass(overlay, 'wsbin-btn-danger')[0]
  assert.notEqual(confirm, undefined)
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ ok: true, value: { applied: 'moved' } }) }
  }
  confirm.props.onClick()
  await new Promise((settle) => setTimeout(settle, 0))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].endpoint, 'relocate')
  assert.deepEqual(requests[0].payload, { sessionId: 'session-1', targetWorkspaceId: 'ws-2' })
  assert.equal(exported.__stores.moveRequestStore.get(), null)
})

test('会话菜单行能渲染并触发 requestDelete', async () => {
  const exported = await loadClient()
  const { ctx, calls } = fakeClientCtx()
  const definitions = []
  ctx.slots.register = (definition, component) => {
    definitions.push({ definition, component })
    calls.slots.push(definition)
    return () => {}
  }
  exported.apply(ctx)
  const slot = definitions.find((entry) => entry.definition.name === 'sidebar.workspaces.session.menu.item')
  assert.notEqual(slot, undefined)
  let requested = null
  const tree = render(slot.component({
    sessionId: 'session-1',
    displayTitle: '演示会话',
    useMenuOpenState: () => [false, () => {}],
    requestDelete: (sessionId, displayTitle) => { requested = { sessionId, displayTitle } },
    t: (key) => key,
  }))
  assert.equal(texts(tree).includes('menu.deleteSession'), true)
  const button = findByClass(tree, 'wsbin-menu-item')[0]
  assert.notEqual(button, undefined)
  button.props.onClick()
  assert.deepEqual(requested, { sessionId: 'session-1', displayTitle: '演示会话' })
})
