/**
 * dsh-workspace-bin — Client half.
 *
 * 三个贡献，全部只通过 Host 的精确 Fetch 路由 `/api/workspace-bin` 干活
 * （删除/恢复的事务一律在 Host 侧，这里不碰文件）：
 *
 *   - 会话右键菜单：`sidebar.workspaces.session.menu.item` →「放入回收站」，
 *     带确认面板（大小 / 活会话 / 搬运方式）；工作区的删除交给 DSH 自带按钮，
 *     本插件不再占用工作区右键菜单；
 *   - 侧栏页脚：`sidebar.footer.action` →「回收站 (N)」；
 *   - `shell.overlay`：回收站面板（恢复 / 永久删除 / 清空）+ 结果提示。
 *
 * 只从模块表里 require `react`，图标是内联 SVG，颜色走 `--dsw-alias-*` 变量并带
 * 字面量回退：主题改名只会让面板掉回默认色，不会让它消失。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace-bin',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 官方 UI 原语（图标等）。拿不到就退回内联 SVG，绝不让插件加载失败。
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    /** 官方「删除工作区」用的同一个垃圾桶图标。 */
    const OfficialTrashIcon = primitives !== null && typeof primitives === 'object'
      ? primitives.IconTrashOutlineRegular
      : undefined

    /** 本 bundle 文案的 locale 命名空间。 */
    const NS = 'workspaceBin'
    /** Host 路由，相对页面自身 base（挂载前缀不需要特殊处理）。 */
    const ROUTE = '/api/workspace-bin'.slice(1)

    const ZH = {
      'menu.deleteSession': '回收会话',
      'dialog.title': '删除到回收站',
      'dialog.close': '关闭',
      'dialog.descSession': '「{title}」这个会话会移入回收站，文件不会立刻删除；随时可以恢复。',
      'dialog.path': '目录',
      'dialog.sessions': '{count} 个会话',
      'dialog.size': '约 {size}',
      'dialog.live': '其中 {count} 个会话正在运行，会先被停掉（最多等 3 秒）。',
      'dialog.modeSession': '会话目录会整体搬移，工作区登记保持不变。',
      'dialog.kept': '工作区目录本身、附件与搜索索引不在删除范围内。',
      'dialog.planning': '正在核对要删除的内容…',
      'dialog.cancel': '取消',
      'dialog.confirm': '放入回收站',
      'dialog.deleting': '正在移入回收站…',
      'bin.open': '回收站',
      'bin.title': '回收站',
      'bin.timing': '删除只是把数据搬进回收站；「永久删除」才会真正删字节，且不可恢复。',
      'bin.loading': '正在读取回收站…',
      'bin.empty': '回收站是空的。',
      'bin.broken': '{count} 个条目损坏，已跳过（数据仍在磁盘上，不会自动删除）。',
      'bin.workspace': '工作区',
      'bin.session': '会话',
      'bin.sessions': '{count} 个会话',
      'bin.restore': '恢复',
      'bin.restoring': '正在恢复…',
      'bin.purge': '永久删除',
      'bin.failed': '失败',
      'bin.purging': '正在删除…',
      'bin.clear': '清空回收站',
      'bin.showMore': '显示更多（还有 {count} 条）',
      'bin.clearing': '正在清空…',
      'bin.close': '关闭',
      'bin.confirmPurge': '永久删除「{title}」？字节会被真正删掉，无法恢复。',
      'bin.confirmClear': '清空回收站里的全部 {count} 个条目？无法恢复。',
      'bin.confirmYes': '确认删除',
      'bin.confirmNo': '再想想',
      'toast.moved': '已把「{title}」放入回收站',
      'toast.moving': '正在移动会话…',
      'toast.movedTo': '会话已移到目标工作区',
      'toast.restored': '已恢复「{title}」',
      'toast.purged': '已永久删除 {count} 个条目',
      'toast.cleared': '回收站已清空',
      'error.unknown-workspace': '这个工作区已经不在注册表里了。',
      'error.caller-session': '不能删除正在执行这次操作的工作区。',
      'error.no-sessions-root': '定位不到会话存储根目录，为安全起见拒绝操作。',
      'error.session-busy': '还有会话在写日志，停不下来，已取消（没动任何文件）。正在查看这个工作区时，先切到别的会话再删。',
      'error.project-unreadable': '项目目录读不了，已取消。',
      'error.move-failed': '搬移失败，已回滚（没有丢数据）。',
      'error.registry-failed': '删除工作区登记失败，已回滚。',
      'error.restore-conflict': '目标位置已有同名会话目录，已取消恢复。',
      'error.restore-failed': '恢复失败，已回滚。',
      'error.not-done': '这个条目还没删完，先重启 DSH 让它收敛。',
      'error.wrong-kind': '条目类型不匹配。',
      'error.invalid-request': '请求参数不合法，已中止。',
      'error.bad-request': '请求体不合法，已中止。',
      'error.failed': '宿主内部出错，已中止。',
      'error.session-too-large': '这个会话的日志太大，一次性搬移会吃掉太多内存，已拒绝（先拆分或用命令行处理）。',
    }

    const EN = {
      'menu.deleteSession': 'Recycle session',
      'dialog.title': 'Move to Recycle Bin',
      'dialog.close': 'Close',
      'dialog.descSession': '"{title}" moves to the recycle bin. Its files are kept and it can be restored at any time.',
      'dialog.path': 'Directory',
      'dialog.sessions': '{count} session(s)',
      'dialog.size': 'about {size}',
      'dialog.live': '{count} session(s) are running and will be stopped first (waiting up to 3 seconds).',
      'dialog.modeSession': 'The session directory moves as a whole; workspace membership is left alone.',
      'dialog.kept': 'The workspace folder itself, attachments and the search index stay untouched.',
      'dialog.planning': 'Checking what would be removed…',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Move to Recycle Bin',
      'dialog.deleting': 'Moving to the recycle bin…',
      'bin.open': 'Recycle Bin',
      'bin.title': 'Recycle Bin',
      'bin.timing': 'A delete only moves data here; "Delete permanently" is the only action that removes bytes, and it cannot be undone.',
      'bin.loading': 'Reading the recycle bin…',
      'bin.empty': 'The recycle bin is empty.',
      'bin.broken': '{count} broken entr(ies) skipped (their bytes stay on disk and are never auto-deleted).',
      'bin.workspace': 'Workspace',
      'bin.session': 'Session',
      'bin.sessions': '{count} session(s)',
      'bin.restore': 'Restore',
      'bin.restoring': 'Restoring…',
      'bin.purge': 'Delete permanently',
      'bin.failed': 'Failed',
      'bin.purging': 'Deleting…',
      'bin.clear': 'Empty the bin',
      'bin.showMore': 'Show more ({count} left)',
      'bin.clearing': 'Emptying…',
      'bin.close': 'Close',
      'bin.confirmPurge': 'Delete "{title}" permanently? Its bytes are removed for good.',
      'bin.confirmClear': 'Empty all {count} entr(ies) in the recycle bin? This cannot be undone.',
      'bin.confirmYes': 'Delete permanently',
      'bin.confirmNo': 'Keep them',
      'toast.moved': '"{title}" is in the recycle bin',
      'toast.moving': 'Moving the session…',
      'toast.movedTo': 'The session moved to the target workspace',
      'toast.restored': 'Restored "{title}"',
      'toast.purged': 'Permanently deleted {count} entr(ies)',
      'toast.cleared': 'The recycle bin is empty',
      'error.unknown-workspace': 'That workspace is no longer in the registry.',
      'error.caller-session': 'The workspace running this operation cannot delete itself.',
      'error.no-sessions-root': 'The session storage root could not be located, so the operation was refused.',
      'error.session-busy': 'Some sessions are still writing and could not be stopped; nothing was moved. If you are viewing this workspace, switch to another session and retry.',
      'error.project-unreadable': 'The project directory cannot be read; nothing was moved.',
      'error.move-failed': 'Moving failed and was rolled back (nothing was lost).',
      'error.registry-failed': 'Removing the workspace registration failed and was rolled back.',
      'error.restore-conflict': 'A directory already exists at the restore target; the restore was cancelled.',
      'error.restore-failed': 'Restore failed and was rolled back.',
      'error.not-done': 'This entry never finished deleting; restart DSH to let recovery settle it.',
      'error.wrong-kind': 'The entry kind does not match.',
      'error.invalid-request': 'The request was not valid and nothing happened.',
      'error.bad-request': 'The request body was not valid and nothing happened.',
      'error.failed': 'The Host failed and nothing happened.',
      'error.session-too-large': 'This session log is too large to move in one piece without exhausting memory, so the move was refused.',
    }

    /** Host 返回的错误码 → 本地化文案。 */
    const REFUSAL_KEYS = {
      'workspace-bin/unknown-workspace': 'error.unknown-workspace',
      'workspace-bin/caller-session': 'error.caller-session',
      'workspace-bin/no-sessions-root': 'error.no-sessions-root',
      'workspace-bin/session-busy': 'error.session-busy',
      'workspace-bin/project-unreadable': 'error.project-unreadable',
      'workspace-bin/move-failed': 'error.move-failed',
      'workspace-bin/registry-failed': 'error.registry-failed',
      'workspace-bin/restore-conflict': 'error.restore-conflict',
      'workspace-bin/restore-failed': 'error.restore-failed',
      'workspace-bin/not-done': 'error.not-done',
      'workspace-bin/wrong-kind': 'error.wrong-kind',
      'workspace-bin/invalid-request': 'error.invalid-request',
      'workspace-bin/bad-request': 'error.bad-request',
      'workspace-bin/failed': 'error.failed',
      'workspace-bin/session-too-large': 'error.session-too-large',
    }

    const STYLES = `
.wsbin-menu-item {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px;
  border: none; border-radius: var(--dsw-radius-md, 8px); background: transparent; cursor: pointer;
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: left;
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.wsbin-menu-item:hover, .wsbin-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.14)); outline: none; }
.wsbin-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; }
.wsbin-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsbin-btn {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 32px;
  padding: 0 12px; border: none; border-radius: var(--dsw-radius-md, 8px); cursor: pointer;
  font-family: inherit; font-size: 13px; line-height: 20px; background: transparent;
  color: var(--dsw-alias-label-primary, #f5f5f5);
}
.wsbin-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
/* 页脚入口跟着侧栏走：撑满可用宽度、左对齐，别做成固定宽的小胶囊。 */
.wsbin-footer-action { width: 100%; justify-content: flex-start; text-align: left; margin: 8px 0; }
.wsbin-btn:disabled { opacity: .4; cursor: not-allowed; }
.wsbin-btn-danger { background: var(--dsw-alias-state-error-primary, #e5484d); color: #fff; }
.wsbin-btn-danger:hover:not(:disabled) { filter: brightness(1.07); background: var(--dsw-alias-state-error-primary, #e5484d); }
.wsbin-modal { pointer-events: auto; position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px; }
.wsbin-mask { position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45)); }
.wsbin-dialog {
  box-sizing: border-box; position: relative; z-index: 1; display: flex; flex-direction: column; gap: 14px;
  width: min(560px, calc(100vw - 48px)); max-height: 100%; padding: 24px; overflow: hidden;
  border-radius: var(--dsw-radius-panel, 16px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-overlay, #202024));
  box-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgba(0,0,0,.36));
  color: var(--dsw-alias-label-primary, #f5f5f5);
}
.wsbin-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.wsbin-head-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wsbin-title { margin: 0; font-size: 17px; line-height: 24px; font-weight: 600; letter-spacing: -.01em; }
.wsbin-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.wsbin-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  border: none; border-radius: var(--dsw-radius-sm, 6px); background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #a8a8ad); }
.wsbin-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #f5f5f5); }
.wsbin-desc { margin: 0; font-size: 14px; line-height: 22px; }
.wsbin-muted { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.wsbin-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 18px; word-break: break-all; }
.wsbin-error { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-state-error-primary, #e5484d); }
.wsbin-list { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
.wsbin-row { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 12px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.04)); }
.wsbin-row:hover { border-color: var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.wsbin-row-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wsbin-row-title { flex: 1; min-width: 0; font-size: 13.5px; line-height: 20px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsbin-row-actions { display: flex; align-items: center; gap: 2px; flex: none; }
.wsbin-row-meta { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.wsbin-row-path { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, #7f7f86); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wsbin-badge { flex: none; font-size: 10px; line-height: 14px; padding: 1px 6px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.14)); color: var(--dsw-alias-label-secondary, #a8a8ad); }
.wsbin-linkbtn { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #a8a8ad); font: inherit; font-size: 12px;
  line-height: 18px; padding: 4px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.wsbin-linkbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #f5f5f5); }
.wsbin-linkbtn:disabled { opacity: .4; cursor: not-allowed; }
.wsbin-linkbtn-danger { color: var(--dsw-alias-state-error-primary, #e5484d); }
.wsbin-linkbtn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229,72,77,.14)); color: var(--dsw-alias-state-error-primary, #e5484d); }
.wsbin-more { align-self: center; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #a8a8ad); font: inherit;
  font-size: 12px; line-height: 18px; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.wsbin-more:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); color: var(--dsw-alias-label-primary, #f5f5f5); }
.wsbin-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px 0 22px; color: var(--dsw-alias-label-secondary, #a8a8ad); }
.wsbin-empty-icon { opacity: .45; }
.wsbin-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 2px;
  padding-top: 12px; border-top: .5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
.wsbin-drop-target { outline: 2px dashed var(--dsw-alias-state-info-primary, #4c9aff); outline-offset: -2px;
  border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
/* 跨工作区拖到目标会话行时，复刻官方同款蓝色插入线；拖到工作区目录（标题行）上不画。 */
.wsbin-drop-before, .wsbin-drop-after { position: relative; }
.wsbin-drop-before::before, .wsbin-drop-after::after {
  content: ""; z-index: 1; pointer-events: none; position: absolute; height: 12px;
  left: calc(-1 * var(--dsh-sidebar-paint-inset, 0px)); right: calc(4px - var(--dsh-sidebar-paint-inset, 0px));
  background:
    linear-gradient(55deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary, #4c9aff) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,
    linear-gradient(125deg, transparent calc(50% - 1px), var(--dsw-alias-state-business-primary, #4c9aff) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,
    linear-gradient(var(--dsw-alias-state-business-primary, #4c9aff) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;
}
.wsbin-drop-before::before { top: -7px; }
.wsbin-drop-after::after { bottom: -7px; }
.wsbin-drop-after::after { bottom: -7px; }
.wsbin-toast { pointer-events: auto; position: fixed; left: 50%; transform: translateX(-50%); z-index: 1000;
  top: max(16px, calc(var(--dsh-frame-top-clearance, 0px) + 12px));
  max-width: min(560px, calc(100vw - 48px)); padding: 10px 16px; border-radius: 10px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24));
  background: var(--dsw-alias-bg-overlay, #26262a); color: var(--dsw-alias-label-primary, #f5f5f5);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.3)); font-size: 13px; line-height: 20px; }
.wsbin-toast-error { color: var(--dsw-alias-state-error-primary, #e5484d); }
.wsbin-confirm { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: 10px;
  border: .5px solid var(--dsw-alias-state-error-primary, #e5484d);
  background: var(--dsw-alias-state-error-primary-a08, rgba(229,72,77,.08)); }
`

    /** 最小外部 store：一个值 + 同步通知。 */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /** 面板是否打开。 */
    const binStore = createStore(false)
    /** 待确认的删除请求，`{ sessionId, displayTitle }` 或 null。工作区删除不经过这里。 */
    const requestStore = createStore(null)
    /** 一次性结果提示，`{ text, error }` 或 null。 */
    const toastStore = createStore(null)
    /** 任何回收站动作之后 +1，让页脚计数与面板重新读。 */
    const revisionStore = createStore(0)
    /** 客户端 cordis 上下文；apply 时填，用来补官方的会话列表刷新。 */
    let clientCtx = null

    /** 订阅一个 store 的值。 */
    function useStoreValue(store) {
      const [value, setValue] = React.useState(store.get())
      React.useEffect(() => {
        setValue(store.get())
        return store.subscribe(() => setValue(store.get()))
      }, [store])
      return value
    }

    /** 一整个插件只挂一个 style 元素，随 effect 一起移除。 */
    function insertStyles(css) {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-plugin', 'dsh-workspace-bin')
      element.textContent = css
      document.head.appendChild(element)
      return () => element.remove()
    }

    /** 字节数 → 人话。 */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value.toFixed(1)} ${units[index]}`
    }

    /** 一条 Host 响应折叠成 `{ ok, value }` / `{ ok:false, code, message }`。 */
    async function callHost(endpoint, payload) {
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload }),
        })
        if (!response.ok) return { ok: false, message: `the Host route answered HTTP ${response.status}` }
        const result = await response.json()
        if (result !== null && typeof result === 'object' && result.ok === true) return { ok: true, value: result.value }
        const error = result !== null && typeof result === 'object' ? result.error : undefined
        return {
          ok: false,
          code: typeof error?.code === 'string' ? error.code : undefined,
          message: typeof error?.message === 'string' ? error.message : 'the Host refused the request',
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    }

    /** 把失败翻译成本地化文案。 */
    function failureText(result, t) {
      const key = result?.code !== undefined ? REFUSAL_KEYS[result.code] : undefined
      if (key !== undefined) return t(key)
      return result?.message ?? t('error.failed')
    }

    /** 一次成功的动作之后：刷新计数与面板。 */
    function bump() {
      revisionStore.set(revisionStore.get() + 1)
    }

    /**
     * 让官方会话列表重新拉一次。
     *
     * 删除 / 搬移完成后，工作区归属变了、会话目录也换了地方；官方列表不会自己重扫，
     * 被删的冷会话会掉进「未分组」、搬走的会话会整行消失。这里复用官方
     * `sessions.refresh()`（重新拉 `session.list`），把行放回正确分组或删掉。
     */
    function refreshSessions() {
      try {
        const sessions = typeof clientCtx?.get === 'function' ? clientCtx.get('sessions') : undefined
        if (sessions !== undefined && typeof sessions.refresh === 'function') {
          void sessions.refresh().catch(() => {})
        }
      } catch {
        // 官方服务不可用就只靠事件；主流程已经完成，不能因此报错。
      }
    }

    /**
     * 删掉的会话如果正开在主视图里，把主视图一起收掉。
     *
     * 官方 `uiWorkspace` 在会话被移除时不会主动清主视图；不处理的话，会话进了回收站，
     * 对话窗口还停在那一页。只在「删的就是当前打开的这个会话」时动手，别误伤别的窗口。
     * @param {string} sessionId 刚被删掉的会话 id。
     */
    function closeOpenSession(sessionId) {
      try {
        const ui = typeof clientCtx?.get === 'function' ? clientCtx.get('uiWorkspace') : undefined
        if (ui === undefined || ui === null) return
        const selection = typeof ui.selection?.getSnapshot === 'function' ? ui.selection.getSnapshot() : undefined
        const current = selection?.sessionId ?? ui.mainReference?.sessionId
        if (current !== sessionId) return
        if (typeof ui.clearMain === 'function') ui.clearMain()
      } catch {
        // 关不掉不影响删除结果；会话已经在回收站里了。
      }
    }

    function TrashIcon() {
      if (OfficialTrashIcon !== undefined && OfficialTrashIcon !== null) return h(OfficialTrashIcon, null)
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M2.6 4.4h10.8' }),
        h('path', { d: 'M6.1 4.4V3.3a.8.8 0 0 1 .8-.8h2.2a.8.8 0 0 1 .8.8v1.1' }),
        h('path', { d: 'M4.2 4.4l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2' }),
        h('path', { d: 'M6.7 7.1v4' }),
        h('path', { d: 'M9.3 7.1v4' }),
      )
    }

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8' }),
        h('path', { d: 'M12 4l-8 8' }),
      )
    }

    /** 会话右键菜单里的那一行：把单个会话放进回收站。 */
    function SessionBinMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'wsbin-menu-item',
        onClick: () => {
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle)
        },
      }, [
        h('span', { key: 'icon', className: 'wsbin-icon', 'aria-hidden': true }, h(TrashIcon, null)),
        h('span', { key: 'label', className: 'wsbin-label' }, t('menu.deleteSession')),
      ])
    }

    /** 一个元素自己的行键（兼容 dataset 与 getAttribute）。 */
    function rowKeyOf(node) {
      if (node === null || node === undefined || typeof node !== 'object') return null
      const direct = typeof node.getAttribute === 'function' ? node.getAttribute('data-row-key') : undefined
      if (typeof direct === 'string') return direct
      const viaDataset = node.dataset?.rowKey ?? node.dataset?.rowkey
      return typeof viaDataset === 'string' ? viaDataset : null
    }

    /** 从事件目标向上找到会话行，返回 sessionId；不是会话行就 null。 */
    function sessionIdOfNode(node) {
      let current = node
      for (let guard = 0; current !== null && current !== undefined && guard < 40; guard += 1) {
        const key = rowKeyOf(current)
        if (key !== null && key.startsWith('session:')) return key.slice('session:'.length)
        current = current.parentNode
      }
      return null
    }

    /** 某个祖先里有多少个工作区行。 */
    function workspaceRowsIn(node) {
      if (node === null || node === undefined || typeof node.querySelectorAll !== 'function') return []
      try {
        return [...node.querySelectorAll('[data-row-key^="workspace:"]')]
      } catch {
        return []
      }
    }

    /**
     * 投放目标 = 最近的、**恰好只含一个工作区行**的祖先（官方把一个文件夹行和它的
     * 会话行放在同一个分组容器里）。含多个工作区行说明指针落在整棵列表上，不介入。
     *
     * @returns {{node: any, workspaceId: string} | null}
     */
    function workspaceGroupOf(node) {
      let current = node
      for (let guard = 0; current !== null && current !== undefined && guard < 40; guard += 1) {
        const rows = workspaceRowsIn(current)
        if (rows.length > 1) return null
        if (rows.length === 1) {
          const key = rowKeyOf(rows[0])
          if (key === null || !key.startsWith('workspace:')) return null
          return { node: current, workspaceId: key.slice('workspace:'.length) }
        }
        current = current.parentNode
      }
      return null
    }

    /** 拖拽搬移：官方行属性 + 就近分组判定，不碰官方拖拽载荷。 */
    function installDrag(ctx) {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {}
      let dragging = null
      let highlighted = null
      let lineAnchor = null
      const t = (key) => ctx.locale.bind(NS)(key)

      const clearHighlight = () => {
        if (highlighted !== null && highlighted.classList !== undefined) highlighted.classList.remove('wsbin-drop-target')
        highlighted = null
      }
      const clearLine = () => {
        if (lineAnchor !== null && lineAnchor.classList !== undefined) {
          lineAnchor.classList.remove('wsbin-drop-before')
          lineAnchor.classList.remove('wsbin-drop-after')
        }
        lineAnchor = null
      }
      const setLine = (node, side) => {
        if (lineAnchor === node && node.classList.contains(`wsbin-drop-${side}`)) return
        clearLine()
        if (node?.classList === undefined) return
        node.classList.add(`wsbin-drop-${side}`)
        lineAnchor = node
      }
      /**
       * 清掉官方残留的蓝色插入线：官方只在自己的分组里画 marker，指针移出分组后
       * 它不会主动清 `drag.over`，所以拖到别的工作区时源分组可能还挂着那条线。
       * 只删形如 `*dropBefore` / `*dropAfter` 的类名，不碰我们自己的 `wsbin-drop-*`。
       */
      const clearNativeMarker = () => {
        if (typeof document.querySelectorAll !== 'function') return
        for (const node of document.querySelectorAll('[class*="dropBefore"], [class*="dropAfter"]')) {
          if (node.classList === undefined || typeof node.classList.remove !== 'function') continue
          for (const token of [...node.classList]) {
            if (/drop(Before|After)$/.test(token)) node.classList.remove(token)
          }
        }
      }
      const reset = () => {
        dragging = null
        clearHighlight()
        clearLine()
      }
      const setHighlight = (node) => {
        if (highlighted === node) return
        clearHighlight()
        if (node?.classList !== undefined) node.classList.add('wsbin-drop-target')
        highlighted = node
      }

      const onDragStart = (event) => {
        const sessionId = sessionIdOfNode(event.target)
        if (sessionId === null) return
        dragging = {
          sessionId,
          sourceWorkspaceId: workspaceGroupOf(event.target)?.workspaceId ?? null,
        }
        try {
          event.dataTransfer?.setData('text/plain', sessionId)
          if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.effectAllowed = 'move'
        } catch {
          // 浏览器拒绝写载荷：不影响我们自己的状态机。
        }
      }

      const onDragOver = (event) => {
        if (dragging === null) return
        const group = workspaceGroupOf(event.target)
        if (group === null || group.workspaceId === dragging.sourceWorkspaceId) {
          clearHighlight()
          clearLine()
          // 指针离开所有分组时，官方那条线也该消失；自己分组内保留（官方组内排序要用）。
          if (group === null) clearNativeMarker()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'move'
        clearNativeMarker()
        // 两种提示互斥：落在会话行上画插入线；落在工作区目录（标题行/空白）上只画虚线分组框。
        const targetNode = event.target
        let row = typeof targetNode?.closest === 'function' ? targetNode.closest('[data-row-key^="session:"]') : null
        if (row === null && typeof targetNode?.getAttribute === 'function'
          && (targetNode.getAttribute('data-row-key') ?? '').startsWith('session:')) row = targetNode
        const ownsRow = row !== null && (typeof group.node.contains !== 'function' || group.node.contains(row))
        if (ownsRow) {
          clearHighlight()
          let side = 'after'
          if (typeof row.getBoundingClientRect === 'function') {
            const rect = row.getBoundingClientRect()
            side = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          }
          setLine(row, side)
        } else {
          setHighlight(group.node)
          clearLine()
        }
      }

      const onDrop = (event) => {
        if (dragging === null) return
        const group = workspaceGroupOf(event.target)
        if (group === null || group.workspaceId === dragging.sourceWorkspaceId) {
          reset()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        const { sessionId } = dragging
        const targetWorkspaceId = group.workspaceId
        reset()
        void moveSession(ctx, t, sessionId, targetWorkspaceId)
      }

      const onDragLeave = (event) => {
        if (highlighted === null) return
        const related = event.relatedTarget
        if (related === null || related === undefined || (typeof highlighted.contains === 'function' && !highlighted.contains(related))) {
          clearHighlight()
          clearLine()
        }
      }

      document.addEventListener('dragstart', onDragStart, true)
      document.addEventListener('dragover', onDragOver, true)
      document.addEventListener('drop', onDrop, true)
      document.addEventListener('dragend', reset, true)
      document.addEventListener('dragleave', onDragLeave, true)
      return () => {
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('dragover', onDragOver, true)
        document.removeEventListener('drop', onDrop, true)
        document.removeEventListener('dragend', reset, true)
        document.removeEventListener('dragleave', onDragLeave, true)
        reset()
      }
    }

    /** 调一次 Host 的 relocate，并把结果变成提示。 */
    async function moveSession(ctx, t, sessionId, targetWorkspaceId) {
      toastStore.set({ text: t('toast.moving') })
      const result = await callHost('relocate', { sessionId, targetWorkspaceId })
      if (result.ok === true) {
        toastStore.set({ text: t('toast.movedTo') })
        bump()
        refreshSessions()
      } else {
        toastStore.set({ text: failureText(result, t), error: true })
      }
    }

    /** 页脚入口：回收站 + 当前条目数。 */
    function FooterAction({ t }) {
      const open = useStoreValue(binStore)
      const revision = useStoreValue(revisionStore)
      const [count, setCount] = React.useState(null)
      React.useEffect(() => {
        let cancelled = false
        callHost('list', {}).then((result) => {
          if (cancelled === false && result.ok === true) setCount(Array.isArray(result.value?.entries) ? result.value.entries.length : 0)
        })
        return () => {
          cancelled = true
        }
      }, [open, revision])
      const label = count === null || count === 0 ? t('bin.open') : `${t('bin.open')} (${count})`
      return h('button', {
        type: 'button',
        className: 'wsbin-btn wsbin-footer-action',
        title: t('bin.title'),
        'aria-expanded': open,
        onClick: () => binStore.set(open === false),
      }, [
        h('span', { key: 'icon', className: 'wsbin-icon' }, h(TrashIcon, null)),
        h('span', { key: 'label', className: 'wsbin-label', style: { marginLeft: '6px' } }, label),
      ])
    }

    /** 面板 + 删除确认 + 结果提示共用一个 overlay 注册位。 */
    function WorkspaceBinOverlay({ t }) {
      const PAGE_SIZE = 40
      const request = useStoreValue(requestStore)
      const open = useStoreValue(binStore)
      const toast = useStoreValue(toastStore)
      const revision = useStoreValue(revisionStore)
      const [plan, setPlan] = React.useState(null)
      const [planError, setPlanError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [rowBusy, setRowBusy] = React.useState(null)
      const [confirm, setConfirm] = React.useState(null)
      const [visibleCount, setVisibleCount] = React.useState(PAGE_SIZE)
      React.useEffect(() => {
        if (open === true) setVisibleCount(PAGE_SIZE)
      }, [open])
      const [listing, setListing] = React.useState({ items: [], broken: [], error: null, loaded: false })

      // 打开确认框时先拿 plan。
      React.useEffect(() => {
        if (request === null) {
          setPlan(null)
          setPlanError(null)
          return undefined
        }
        let cancelled = false
        const payload = request.kind === 'session' ? { sessionId: request.sessionId } : { workspaceId: request.workspaceId }
        setPlan(null)
        setPlanError(null)
        callHost('plan', payload).then((result) => {
          if (cancelled) return
          if (result.ok === true) setPlan(result.value)
          else setPlanError(result)
        })
        return () => {
          cancelled = true
        }
      }, [request])

      // 面板打开或任何动作之后重新读列表。
      React.useEffect(() => {
        if (open === false) return undefined
        let cancelled = false
        callHost('list', {}).then((result) => {
          if (cancelled) return
          if (result.ok === true) {
            setListing({ items: Array.isArray(result.value?.entries) ? result.value.entries : [], broken: Array.isArray(result.value?.broken) ? result.value.broken : [], error: null, loaded: true })
          } else {
            setListing({ items: [], broken: [], error: result, loaded: true })
          }
        })
        return () => {
          cancelled = true
        }
      }, [open, revision])

      // 提示 4.6 秒后自己消失。
      React.useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => toastStore.set(null), 4600)
        return () => clearTimeout(timer)
      }, [toast])

      // Esc：先收确认框，再收面板。
      React.useEffect(() => {
        if (open === false && request === null) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (request !== null) requestStore.set(null)
          else binStore.set(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [open, request])

      const notify = (text, error = false) => toastStore.set({ text, error })

      const confirmDelete = () => {
        if (request === null || plan === null || busy) return
        const payload = request.kind === 'session' ? { sessionId: request.sessionId } : { workspaceId: request.workspaceId }
        const title = request.kind === 'session'
          ? (plan.session?.title || request.displayTitle || request.sessionId)
          : (plan.workspace?.title || plan.workspace?.path || request.displayTitle)
        setBusy(true)
        callHost('move', payload).then((result) => {
          setBusy(false)
          if (result.ok === true) {
            notify(t('toast.moved', { title }))
            requestStore.set(null)
            bump()
            if (request.kind === 'session') closeOpenSession(request.sessionId)
            refreshSessions()
          } else {
            notify(failureText(result, t), true)
          }
        })
      }

      const restoreEntry = (entry) => {
        if (rowBusy !== null) return
        setRowBusy({ action: 'restore', id: entry.id })
        callHost('restore', { entryId: entry.id }).then((result) => {
          setRowBusy(null)
          if (result.ok === true) {
            notify(t('toast.restored', { title: entry.title || entry.id }))
            bump()
            refreshSessions()
          } else {
            notify(failureText(result, t), true)
          }
        })
      }

      const purgeEntries = (entryIds) => {
        setConfirm(null)
        setRowBusy({ action: 'purge', id: entryIds?.[0] ?? '*' })
        callHost('empty', entryIds === undefined ? {} : { entryIds }).then((result) => {
          setRowBusy(null)
          if (result.ok === true) {
            const count = Array.isArray(result.value?.purged) ? result.value.purged.length : 0
            notify(entryIds === undefined ? t('toast.cleared') : t('toast.purged', { count }))
            bump()
            refreshSessions()
          } else {
            notify(failureText(result, t), true)
          }
        })
      }

      /** 确认框只服务单会话删除。 */
      const describeRequest = () => {
        if (request === null) {
          return { title: '', path: '', count: 0, size: 0, live: 0, mode: '', description: 'dialog.descSession' }
        }
        return {
          title: plan?.session?.title || request.displayTitle || request.sessionId,
          path: plan?.session?.cwd ?? '',
          count: 1,
          size: plan?.size ?? 0,
          live: plan?.session?.live === true ? 1 : 0,
          mode: t('dialog.modeSession'),
          description: 'dialog.descSession',
        }
      }
      const described = describeRequest()

      const dialog = request === null ? null : h('div', { className: 'wsbin-modal', role: 'dialog', 'aria-modal': 'true' }, [
        h('div', { key: 'mask', className: 'wsbin-mask', onClick: () => (busy ? undefined : requestStore.set(null)) }),
        h('div', { key: 'card', className: 'wsbin-dialog' }, [
          h('div', { key: 'head', className: 'wsbin-head' }, [
            h('h2', { key: 'title', className: 'wsbin-title' }, t('dialog.title')),
            h('button', { key: 'close', type: 'button', className: 'wsbin-close', 'aria-label': t('dialog.close'), onClick: () => requestStore.set(null) }, h(CloseIcon, null)),
          ]),
          h('p', { key: 'desc', className: 'wsbin-desc' }, t(described.description, { title: described.title })),
          plan === null ? h('p', { key: 'planning', className: 'wsbin-muted' }, t('dialog.planning')) : h('div', { key: 'plan' }, [
            h('div', { key: 'path', className: 'wsbin-muted' }, t('dialog.path')),
            h('div', { key: 'code', className: 'wsbin-code' }, described.path),
            h('p', { key: 'meta', className: 'wsbin-muted', style: { marginTop: '8px' } },
              [t('dialog.sessions', { count: described.count }), described.size > 0 ? t('dialog.size', { size: formatBytes(described.size) }) : null].filter(Boolean).join(' · ')),
            described.live === 0 ? null : h('p', { key: 'live', className: 'wsbin-muted' }, t('dialog.live', { count: described.live })),
            h('p', { key: 'mode', className: 'wsbin-muted' }, described.mode),
            h('p', { key: 'kept', className: 'wsbin-muted' }, t('dialog.kept')),
          ]),
          planError === null ? null : h('p', { key: 'error', className: 'wsbin-error', role: 'alert' }, failureText(planError, t)),
          h('div', { key: 'footer', className: 'wsbin-footer' }, [
            h('button', { key: 'cancel', type: 'button', className: 'wsbin-btn', disabled: busy, onClick: () => requestStore.set(null) }, t('dialog.cancel')),
            h('button', { key: 'confirm', type: 'button', className: 'wsbin-btn wsbin-btn-danger', disabled: busy || plan === null, onClick: confirmDelete },
              busy ? t('dialog.deleting') : t('dialog.confirm')),
          ]),
        ]),
      ])

      const shownCount = Math.min(visibleCount, listing.items.length)
      const rows = listing.items.slice(0, shownCount).map((entry) => h('div', { key: entry.id, className: 'wsbin-row' }, [
        h('div', { key: 'head', className: 'wsbin-row-head' }, [
          h('span', { key: 'badge', className: 'wsbin-badge' }, entry.kind === 'workspace' ? t('bin.workspace') : t('bin.session')),
          h('span', { key: 'title', className: 'wsbin-row-title', title: entry.title || entry.id }, entry.title || entry.id),
          h('div', { key: 'actions', className: 'wsbin-row-actions' }, [
            h('button', {
              key: 'restore',
              type: 'button',
              className: 'wsbin-linkbtn',
              disabled: rowBusy !== null,
              onClick: () => restoreEntry(entry),
            }, rowBusy?.action === 'restore' && rowBusy.id === entry.id ? t('bin.restoring') : t('bin.restore')),
            h('button', {
              key: 'purge',
              type: 'button',
              className: 'wsbin-linkbtn wsbin-linkbtn-danger',
              disabled: rowBusy !== null || entry.state === 'planned',
              onClick: () => setConfirm({ kind: 'one', entry }),
            }, t('bin.purge')),
          ]),
        ]),
        h('div', { key: 'meta', className: 'wsbin-row-meta' },
          [t('bin.sessions', { count: entry.sessionCount }), entry.size > 0 ? formatBytes(entry.size) : null, entry.state === 'failed' ? t('bin.failed') : null].filter(Boolean).join(' · ')),
        h('div', { key: 'path', className: 'wsbin-row-path', title: entry.workspace?.path ?? '' }, entry.workspace?.path ?? ''),
      ]))
      const more = listing.items.length > shownCount
        ? h('button', {
            key: 'more',
            type: 'button',
            className: 'wsbin-more',
            onClick: () => setVisibleCount(shownCount + PAGE_SIZE),
          }, t('bin.showMore', { count: listing.items.length - shownCount }))
        : null

      const confirmBar = confirm === null ? null : h('div', { key: 'confirm', className: 'wsbin-confirm', role: 'alertdialog' }, [
        h('p', { key: 'text', style: { margin: 0, fontSize: '13px', lineHeight: '20px' } },
          confirm.kind === 'one'
            ? t('bin.confirmPurge', { title: confirm.entry.title || confirm.entry.id })
            : t('bin.confirmClear', { count: listing.items.length })),
        h('div', { key: 'actions', style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, [
          h('button', { key: 'no', type: 'button', className: 'wsbin-linkbtn', onClick: () => setConfirm(null) }, t('bin.confirmNo')),
          h('button', {
            key: 'yes',
            type: 'button',
            className: 'wsbin-btn wsbin-btn-danger',
            onClick: () => (confirm.kind === 'one' ? purgeEntries([confirm.entry.id]) : purgeEntries(undefined)),
          }, t('bin.confirmYes')),
        ]),
      ])

      const panel = open === false ? null : h('div', { className: 'wsbin-modal', role: 'dialog', 'aria-modal': 'true' }, [
        h('div', { key: 'mask', className: 'wsbin-mask', onClick: () => binStore.set(false) }),
        h('div', { key: 'card', className: 'wsbin-dialog' }, [
          h('div', { key: 'head', className: 'wsbin-head' }, [
            h('div', { key: 'main', className: 'wsbin-head-main' }, [
              h('h2', { key: 'title', className: 'wsbin-title' }, t('bin.title')),
              h('p', { key: 'hint', className: 'wsbin-hint' }, t('bin.timing')),
            ]),
            h('button', { key: 'close', type: 'button', className: 'wsbin-close', 'aria-label': t('bin.close'), onClick: () => binStore.set(false) }, h(CloseIcon, null)),
          ]),
          listing.error === null ? null : h('p', { key: 'error', className: 'wsbin-error', role: 'alert' }, failureText(listing.error, t)),
          listing.broken.length === 0 ? null : h('p', { key: 'broken', className: 'wsbin-error' }, t('bin.broken', { count: listing.broken.length })),
          listing.loaded === false ? h('p', { key: 'loading', className: 'wsbin-muted' }, t('bin.loading')) : null,
          listing.loaded === true && listing.items.length === 0 ? h('div', { key: 'empty', className: 'wsbin-empty' }, [
            h('span', { key: 'icon', className: 'wsbin-empty-icon' }, h(TrashIcon, null)),
            h('span', { key: 'text' }, t('bin.empty')),
          ]) : null,
          h('div', { key: 'list', className: 'wsbin-list' }, rows),
          more,
          confirmBar,
          h('div', { key: 'footer', className: 'wsbin-footer' }, [
            h('button', {
              key: 'clear',
              type: 'button',
              className: 'wsbin-linkbtn wsbin-linkbtn-danger',
              disabled: rowBusy !== null || listing.items.length === 0,
              onClick: () => setConfirm({ kind: 'all' }),
            }, rowBusy?.action === 'purge' && rowBusy.id === '*' ? t('bin.clearing') : t('bin.clear')),
            h('button', { key: 'close', type: 'button', className: 'wsbin-linkbtn', onClick: () => binStore.set(false) }, t('bin.close')),
          ]),
        ]),
      ])

      return h(React.Fragment, null, dialog, panel, toast === null ? null : h('div', {
        className: toast.error === true ? 'wsbin-toast wsbin-toast-error' : 'wsbin-toast',
        role: 'status',
      }, toast.text))
    }

    /** Client 服务：`slots`（槽位）与 `locale`（文案）。 */
    const inject = ['slots', 'locale']

    /**
     * 挂载客户端半边。
     * @param {any} ctx 客户端 cordis 上下文。
     */
    function apply(ctx) {
      clientCtx = ctx
      ctx.effect(() => insertStyles(STYLES), 'workspace-bin: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'workspace-bin: dictionaries')

      // 菜单图标的槽位契约：按 key 注册一个组件。
      ctx.effect(() => installDrag(ctx), 'workspace-bin: drag')

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'workspace-bin.session',
        order: 500,
        locale: NS,
        inject: () => ({
          requestDelete: (sessionId, displayTitle) => requestStore.set({
            kind: 'session',
            sessionId,
            displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
          }),
        }),
      }, SessionBinMenuItem))

      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'workspace-bin.footer',
        order: 620,
        locale: NS,
        inject: () => ({}),
      }, FooterAction))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workspace-bin.overlay',
        locale: NS,
        inject: () => ({}),
      }, WorkspaceBinOverlay))
    }

    // `__stores` 只给单测用：Node 里没有 React 渲染器，测试靠它把面板打开再渲染。
    // 网页端不会读它，改成别的形状也不影响插件工作。
    return {
      inject,
      apply,
      formatBytes,
      __stores: { binStore, requestStore, toastStore, revisionStore },
      __drag: { sessionIdOfNode, workspaceGroupOf },
      __sync: { refreshSessions, closeOpenSession },
    }
  },
})
