import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 在 Node 里加载网页端 bundle：假 `window.__ModuleLoader__` 捕获 factory，
 * 假 `react` 让组件定义阶段不炸，假 `document` 记录 style 注入。
 * 只验证「注册了什么、契约对不对」，不渲染组件（渲染属于真机验收）。
 */
let loadCounter = 0

async function loadClient() {
  const captured = {}
  globalThis.window = { __ModuleLoader__: { load(definition) { captured.definition = definition } } }
  const styles = []
  globalThis.document = {
    createElement() {
      const element = {
        textContent: '',
        attributes: {},
        remove() {},
        setAttribute(name, value) { this.attributes[name] = value },
      }
      return element
    },
    head: { appendChild(element) { styles.push(element) } },
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
  await import(`../client.js?load=${loadCounter}`)
  const definition = captured.definition
  assert.notEqual(definition, undefined)
  const exported = definition.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  })
  return { definition, exported, styles }
}

/** 假客户端 ctx，记录每类注册。 */
function fakeClientCtx() {
  const calls = { menus: [], slots: [], locales: [], effects: [] }
  const dictionary = {}
  return {
    calls,
    ctx: {
      get(name) {
        if (name !== 'contextMenus') return undefined
        return {
          register(definition) {
            calls.menus.push(definition)
            return () => {}
          },
        }
      },
      effect(fn, label) {
        calls.effects.push(label)
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      locale: {
        register(namespace, dictionaries) {
          calls.locales.push({ namespace, dictionaries })
          Object.assign(dictionary, dictionaries.zh)
        },
        bind(namespace) {
          return (key) => dictionary[key] ?? key
        },
      },
      slots: {
        inject(name, factory) {
          factory()
          return () => {}
        },
        register(definition) {
          calls.slots.push(definition)
          return () => {}
        },
      },
    },
  }
}

test('client bundle 的模块契约与导出', async () => {
  const { definition, exported } = await loadClient()
  assert.equal(definition.id, 'dsh-session-bin')
  assert.deepEqual(exported.inject, ['slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
  assert.equal(typeof exported.formatBytes, 'function')
})

test('不再占用工作区右键菜单（工作区删除交给 DSH 自带按钮）', async () => {
  const { exported } = await loadClient()
  const { ctx, calls } = fakeClientCtx()
  exported.apply(ctx)

  assert.equal(calls.menus.length, 0)
  assert.equal(ctx.inject === undefined || typeof ctx.inject === 'function', true)
})

test('槽位注册齐全：菜单图标、页脚、overlay', async () => {
  const { exported } = await loadClient()
  const { ctx, calls } = fakeClientCtx()
  exported.apply(ctx)

  const byName = new Map(calls.slots.map((slot) => [slot.name, slot]))
  assert.equal(byName.get('sidebar.workspaces.session.menu.item')?.order, 500)
  assert.equal(byName.get('sidebar.footer.action')?.locale, 'sessionBin')
  assert.equal(byName.get('shell.overlay')?.locale, 'sessionBin')
  assert.equal(calls.slots.length, 3)
  assert.equal(calls.locales.length, 1)
  assert.equal(calls.locales[0].namespace, 'sessionBin')
  assert.equal(calls.locales[0].dictionaries.zh['menu.deleteSession'], '回收会话')
  assert.equal(typeof calls.locales[0].dictionaries.zh['dialog.descSession'], 'string')
  assert.equal(typeof calls.locales[0].dictionaries.en['menu.deleteSession'], 'string')
  assert.equal(calls.effects.includes('session-bin: styles'), true)
})

test('删掉的会话正开着时收掉主视图', async () => {
  const { exported } = await loadClient()
  const { ctx } = fakeClientCtx()
  exported.apply(ctx)

  let cleared = 0
  const ui = {
    selection: { getSnapshot: () => ({ sessionId: 's-1' }) },
    clearMain: () => { cleared += 1 },
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'uiWorkspace' ? ui : originalGet(name))

  exported.__sync.closeOpenSession('s-1')
  assert.equal(cleared, 1)
  exported.__sync.closeOpenSession('s-2')
  assert.equal(cleared, 1, '删的不是当前会话时不能动主视图')

  ui.selection.getSnapshot = () => ({})
  ui.mainReference = { sessionId: 's-3' }
  exported.__sync.closeOpenSession('s-3')
  assert.equal(cleared, 2, 'selection 为空时用主引用兜底')
})

test('拖拽高亮 / toast / 确认条的关键样式还在（防重设计误删）', async () => {
  const { exported, styles } = await loadClient()
  const { ctx } = fakeClientCtx()
  exported.apply(ctx)
  const css = styles.map((element) => element.textContent).join('\n')
  for (const selector of ['.sbin-drop-target', '.sbin-drop-before', '.sbin-drop-after', '.sbin-toast', '.sbin-toast-error', '.sbin-confirm']) {
    assert.equal(css.includes(selector), true, `missing ${selector}`)
  }
})

test('部分完成回执会生成可读提示', async () => {
  const { exported } = await loadClient()
  const t = (key, params) => (params?.count === undefined ? key : `${key}:${params.count}`)
  assert.equal(exported.__sync.partialFailureText({ ok: true, value: {} }, t), null)
  const warning = exported.__sync.partialFailureText({ ok: true, value: { warnings: ['attach failed'] } }, t)
  assert.equal(warning.includes('toast.partial:1'), true)
  assert.equal(warning.includes('attach failed'), true)
  const registry = exported.__sync.partialFailureText({ ok: true, value: { registry: { applied: false } } }, t)
  assert.equal(registry.includes('warn.registryPending'), true)
  const errors = exported.__sync.partialFailureText({ ok: true, value: { errors: ['e1', 'e2'] } }, t)
  assert.equal(errors.includes('toast.partial:2'), true)
})

test('formatBytes 边界', async () => {
  const { exported } = await loadClient()
  assert.equal(exported.formatBytes(0), '0 B')
  assert.equal(exported.formatBytes(1023), '1023 B')
  assert.equal(exported.formatBytes(1024), '1.0 KB')
  assert.equal(exported.formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(exported.formatBytes(-1), '')
  assert.equal(exported.formatBytes(undefined), '')
})

test('中文与英文词典键集合一致', async () => {
  const { exported } = await loadClient()
  const { ctx, calls } = fakeClientCtx()
  exported.apply(ctx)
  const dictionaries = calls.locales[0].dictionaries
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
})
