# 任务拆分 · dsh-workspace-bin

> 历史文档：写于 `dsh-workspace-bin` 时期。当前包名 `dsh-session-bin`、插件 id `session-bin`
> （0.1.0 起，版本号重新起算）；下文保留当时的旧名。

> 依据 `PLAN.md` v0.1 拆成可独立验收的任务。状态：⬜ 未开始 / 🔄 进行中 / ✅ 完成。
> 更新规则：一个任务做完才改状态；验收证据写在任务行的「验收」列里，不另开文档。

## 0. 环境事实（2026-11-12 已核实）

- 宿主：DSH **0.2.2-rc.1**（desktop profile），Node 22.21.1，pnpm 11.13.1。
- 核心包只在 `app.asar` 里；已用自写 asar 读取器核对 `dsh-workspace`、`dsh-session-persistence`、
  `dsh-session-persistence-jsonl` 的 README 与类型（不是猜的）。
- 参考插件就装在本机 `~/.dsh/profiles/desktop/node_modules/`：`dsh-plugin-session-purge@1.3.6`、
  `dsh-session-relocate@0.2.6`，可直接读源码；`dsh-workspace-control` 未装，按 PLAN 的描述实现。
- **写入边界**：本会话沙箱只能写 `dsh-workspace-bin/`。往 `~/.dsh/...` 装插件需要你批准，
  因此「真机安装 + 验收」单独放在 M4-3，不阻塞 M1~M3 的开发与单测。
- 本地开发一律用 workspace 内的 fake home（`.test-tmp/`），绝不碰真实 `~/.dsh` 数据。

## 1. 里程碑与任务

### M0 骨架

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| ✅ M0-1 | 包骨架 | `package.json`（`dsh.bundle.patch` + `dsh.client.inject` + `engines.dsh`）、`cordis.patch.yml`、根 `host.js` 入口、`.gitignore` | — | `node --input-type=module -e "import('./host.js')"` 能解析；`apply`/`inject` 导出齐全 |
| ✅ M0-2 | 测试基建 | `.test-tmp/<random>` fake home 工厂、`node --test` 脚本、共享 fixture（造 workspace/会话目录） | M0-1 | `npm test` 空跑通过；fixture 重复使用不串数据 |

### M1 回收站 Host（无 UI，curl 可驱动）

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| ✅ M1-1 | 路径层 | `src/host/paths.js`：`projectKey` / `encodeSegment` / `projectKeyCollisions` | M0-2 | 单测覆盖 DESIGN.md 的 4 个真实样本（`D:\示例\A` 等）与 `.`/`..` 边界 |
| ✅ M1-2 | 回收站模型 | `src/host/trash.js`：`entryId`、manifest 原子写（fsync+rename）、`planned→done/failed` 状态机、`scan`、损坏条目隔离、`entrySize` | M0-2 | 单测：往返、非法 manifest 拒绝、非法状态跳转拒绝、scan 跳过非条目、原子写不留 tmp |
| ✅ M1-3 | 删除工作区事务 | `src/host/workspace.js`：门禁（caller 会话/工作区存在/目录可读/活会话 ≤3s 停活+驱逐）→ 写 `planned` → 整目录 rename（碰撞或目录内容不符时降级逐会话）→ `registry.delete(id)` → 摘归档/置顶 → `done`；失败回滚 rename + `registry.create` + `attachSession` | M1-1,M1-2 | fake registry 单测：成功/rename 失败/registry 失败/碰撞降级/重复删除幂等 |
| ✅ M1-4 | 恢复工作区 | rename 回源目录 → `registry.create(path)` → 逐会话 `attachSession` → 还原归档/置顶 → 删条目；目录缺失时只恢复会话并报「工作区目录缺失」 | M1-3 | 单测：完整恢复、目录缺失降级、恢复后 bin 条目消失、重复恢复幂等 |
| ✅ M1-5 | 永久删除 / 清空 | `rm -rf <entry>` + `session_projcache/sessions/<id>.json` 删除 + 空项目层回收；绝不触碰附件与工作区目录 | M1-4 | 单测：真删只删指定条目、projcache 条目消失、`empty` 清空后 bin 根仍在 |
| ✅ M1-6 | HTTP 路由 | `src/host/routes.js`：`ctx.connection.fetch.register('/api/workspace-bin')`，`{endpoint,payload}` → `plan/move/list/restore/empty` 统一信封；错误码稳定、非法请求 400 | M1-3~M1-5 | fake ctx 单测：五个端点、未知端点、坏 JSON、错误码；真机 curl 见 M1-8 |
| ✅ M1-7 | 启动恢复 | `src/host/workspace.js` 的 `recover()`：扫 bin，`planned` 条目「源目录还在就回滚、已进 bin 就补完登记删除」，绝不自动删字节 | M1-6 | 单测：模拟 kill -9 的三种中间态（rename 前/后/registry 删除前）各自收敛 |
| ✅ M1-8 | M1 验收 | `scripts/m1-e2e.mjs`：真文件系统 + 真回收站 + 真事务 + 真路由信封（注册表/sessions 用假实现）；`test/apply.test.mjs` 验证 `apply` 挂的精确路由形状与 `resolveHome` | M1-1~M1-7 | 脚本全绿；44 个单测全绿；真实 `~/.dsh` 零改动。真宿主隔离实例启动（base+web-app+本插件）归 M4-3，装 profile 要你批准 |

### M2 客户端

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| ✅ M2-1 | 客户端骨架 | `client.js`（`__ModuleLoader__.load` 形态，不打包）、内联 zh/en 词典、相对路由 `/api/workspace-bin` | M1-6 | 假 loader + 假 ctx 验证导出面、三种注册与词典键一致；真机加载待 M4-3 |
| ⛔ M2-2 | 工作区菜单（已移除） | 2026-11-12 按用户决定移除：DSH 自带「删除工作区」，不再叠加第二个删除项。Host 事务保留，仅用于恢复旧条目与内部回归 | M2-1,M1-3 | 客户端不再注册 `contextMenus`；`node --test` 89 全绿 |
| 🔄 M2-3 | 回收站面板 | `sidebar.footer.action` 入口 + `shell.overlay` 面板：逐条恢复/永久删除、底部清空（二次确认）、损坏条目告警 | M2-1,M1-4,M1-5 | 代码 + 渲染冒烟（空面板/对话框可展开）完成；真机打开/恢复/删除待 M4-3 |
| ✅ M2-4 | 状态同步 | 回收站动作后 `revisionStore` 让页脚计数与面板重读；删/搬后调官方 `sessions.refresh()` 重拉列表，Host 删除成功补发 `api-session/removed`（冷会话没有 `session/disposed`） | M2-3 | 隔离实例 + 真浏览器：删会话行消失、恢复回原分组、拖拽落目标分组、整工作区删除无「未分组」 |

### M3 会话删除与跨区移动

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| ✅ M3-1 | 单会话删除/恢复 | `src/host/session.js`：停活→detach→目录 rename 进 bin（`kind:session`）→摘成员/归档/置顶；恢复回原项目目录 + `attachSession` + 还原标记；原工作区没了落未分组 | M1-2,M1-5 | 单测 10 条（含 busy/冲突/未知/启动恢复）；`node scripts/m3-session-e2e.mjs` 全绿；归档会话恢复后仍归档 |
| ✅ M3-2 | 跨区移动事务 | `src/host/move.js`：停活 → 读 header+已提交事件 → park 到 `_workspace-bin-staging/<opId>/`（带 journal）→ `create({...header,cwd}, {inheritedEventCount})` + `append` + `flush` → 读回校验（条数/lastSeq/cwd）→ 删 parked → 刷新 header 索引 + 旧 detach/新 attach → 删 projcache；失败回滚；启动 `recoverMoves()` 补完或回滚 | M3-1 | 10 条单测（成功/seeded/targetPath/already-there/busy/建失败/归属失败/恢复补完/恢复回滚/错误码）+ `scripts/m3-move-e2e.mjs` 全绿 |
| ✅ M3-3 | 拖拽 | `client.js` 的 `installDrag`：会话行 dragstart、目标分组 dragover 高亮、drop 调 `relocate`；分组判定 = 最近且恰好含一个 workspace 行的祖先；自己分组与整棵列表都不介入；失败/忙碌有 toast；大日志由 Host 拒绝并映射文案 | M3-2 | 假 DOM 事件链单测（跨组接管/自己组让路/整树不接管/relocate 载荷）；多选批量未做；真浏览器 CDP 验收待 M4-3 |

### M4 收尾

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| ✅ M4-1 | 崩溃恢复加固 | 启动恢复补全 + `kill -9` 破坏性脚本；所有「半途」状态都有明确收敛 | ✅ M1-7 | 三种注入点重启后 bin/注册表/会话三者一致 |
| ✅ M4-2 | 边界与降级 | projectKey 碰撞降级、嵌套工作区告警、同项目目录的隐藏子代理随迁 + 异地子代理告警、归档/置顶还原、无 sessions 服务按「不活」降级、大日志护栏。Windows 锁行为只按 POSIX 写了探针，未实测 | M1-3,M2-4,M3-2 | 每类边界有单测（84 个）；降级路径有日志 |
| 🔄 M4-3 | 真机验收 + 文档 | 文档已齐：[INSTALL.md](INSTALL.md)（安装/10 步验收/回滚/已知限制）、[CHANGELOG.md](CHANGELOG.md)、LICENSE、`scripts/check-profile.mjs` 只读预检。装进 desktop profile **已完成**（备份 + 预检通过）。**真实 DSH 隔离实例已跑通**：从 app.asar 提取 0.2.2-rc.1 runtime，起 `--profile web` 独立实例，种入工作区/会话，验证插件加载、路由挂载、认证、list/plan/move/restore 与 `session-busy` 门禁。已确认（2026-11-12 重启后，使用者反馈）：工作区右键菜单与页脚「回收站」入口都出现了，客户端半边在真实 desktop 里加载成功。剩余：完整交互验收（删会话 → 面板恢复/永久删除 → 拖拽）在**重启后的 desktop** 上再点一遍；工作区删除改由 DSH 自带按钮，不再属于本插件验收范围 | 全部 | 真实工作区走通；预检脚本输出无阻断项 |

## 2. 待定决策（实现前拍板，避免返工）

| # | 决策点 | 本鱼鱼的建议 | 理由 |
|---|---|---|---|
| D1 | 删工作区时「整目录 rename」是否安全 | **已落地**：项目目录里多出任何一个不认识的会话目录，就降级逐会话 | 同 projectKey 可能躺着未归属/别的路径的会话，整目录搬会顺手搬走人家 |
| D2 | 活会话（正在答）删工作区 | 默认先停（`workspace/session-stop`）再驱逐，≤3s 停不下就拒绝并列出在跑什么 | 与 PLAN §5 一致；静默杀回合比报错更糟 |
| D3 | 恢复时工作区目录已不存在 | 只恢复会话到「未分组」，bin 条目保留到用户永久删除 | PLAN §7/§12-10；凭空 mkdir 会造出错误项目 |
| D4 | 恢复后归档/置顶 | 按 manifest 记录还原，不信任「当前集合」 | 删除时已从集合摘除，不还原就丢状态 |
| D5 | 清空回收站 | 必二次确认 + 列条数与总大小；清空后 bin 根目录保留 | 唯一删字节动作，误触代价最高 |

## 3. 执行顺序

`M0-1 → M0-2 → M1-1 → M1-2 → M1-3 → M1-4 → M1-5 → M1-6 → M1-7 → M1-8 → M2 → M3 → M4`

M1 内部按「纯函数 → 存储 → 事务 → 路由 → 恢复」推进，每步都有单测，保证后一步出错时前一步可信。

## 4. 风险速查

| 风险 | 触发点 | 缓解 |
|---|---|---|
| 整目录 rename 越界 | ✅ M1-3 | D1 的目录计数校验；不符就逐会话 |
| 崩溃留半套 | M1-3/M1-7 | manifest 先落盘 + 启动恢复只收敛不删字节 |
| registry 私有索引不一致 | M3-2 | 特性探测 + 失败降级「重启后补齐归属」，绝不静默 |
| 同 id 双 artifact | M3-2 | 先 park 再 `create`；校验通过才删 parked |
| 真实数据被测试误伤 | 全程 | 所有测试只写 `.test-tmp/`；真机步骤单独 M4-3 |

## 5. 进展记录

| 日期 | 做了什么 | 证据 |
|---|---|---|
| 2026-11-13 | 修复：跨区移动后目标工作区显示「未命名」 | 根因是 relocate 删掉了 `session_projcache` 记录，冷列表没有 title 投影。改为保留 rows、只更新 `identity.cwd`（查不到记录/写失败才删）。隔离实例：带标题会话 A→B 后刷新页面直接显示标题；`node --test` 103 全绿 |
| 2026-11-12 | 新增：官方删除工作区时把本地目录送进系统回收站 | Host 监听 `domain/changed`（`put` 缓存 path、`deleted` 搬目录）；Electron `shell.trashItem` 优先，macOS 退回 `~/.Trash`，跨卷/保护区拒绝并记日志；插件自身事务 `suppress`。`node --test` 101 全绿；隔离实例 + 真浏览器验证官方删除后目录消失、插件删除时目录保留 |
| 2026-11-12 | 按用户决定移除工作区删除入口 | 客户端不再注册 `contextMenus`；工作区删除交给 DSH 自带按钮（只移除登记）；README/INSTALL/CHANGELOG 同步；`node --test` 89 全绿 |
| 2026-11-12 | 真机反馈修复：删会话/拖拽后侧栏掉进「未分组」、点开 `session/not-found` | 根因：冷会话删掉后没有 `session/disposed`，控制器不发 `api-session/removed`，侧栏把残留行归到「未分组」；拖拽后客户端也没重拉列表。修复：Host 删除成功后补发 `api-session/removed`（会话/工作区都发）；客户端在删除/恢复/拖拽成功后调官方 `sessions.refresh()`。隔离实例+真浏览器验证：删除无残留行、恢复回原分组、拖拽落目标分组、整工作区删除无「未分组」；`node --test` 90 全绿 |
| 2026-11-12 | 真机验收发现并修复：删工作区永远 `session-busy` | 复现：真桌面与隔离实例里，只要工作区被 UI 打开过，`move` 必回 `session-busy`（等 3s 也等不到释放）。根因：`quiesce()` 只 `detach()` 了 SessionStore 条目，`agents` 注册表里的 agent 没摘，`isLive()` 永远为真。修复：停活后调 `agents.detachEntered()` 驱逐 agent；`node --test` 90 个用例全绿，`m1/m3-session/m3-move` e2e 全绿；隔离实例 + 真浏览器跑通「打开工作区→删除→计数→面板恢复→再删→永久删除」 |
| 2026-11-12 | 拆分完成；M0 + M1 全部落地 | `node --test`：44 个用例全绿；`node scripts/m1-e2e.mjs` 走完 plan→move→list→restore→move→empty；`apply` 注册的 `/api/workspace-bin` 路由在假 ctx 上真实驱动了一次 plan；真实 `~/.dsh` 零改动 |
| 2026-11-12 | 修复后真实实例回归：relocate 不再是「两个工作区都有」 | 隔离实例（0.2.2-rc.1）：`relocate session-live-3 → ws-dst` 返回 `applied: moved`；源记录 `[]`、目标记录 `[session-live-3]`、旧目录消失/新目录就位 |
| 2026-11-12 | 真机数据修复：已用 `repair-duplicates.mjs --apply` 摘除真实 registry 里 1 条重复记账（备份 `workspace.json.bak-…`），剩余重复 0；需重启 DSH 生效 | `node scripts/repair-duplicates.mjs` dry-run 保留 DeepseekHarness、从 dsh-workspace-bin 摘除；apply 后复查 duplicates=0 |
| 2026-11-12 | 真机反馈修复：拖拽后两个工作区同时显示会话 | 根因：detach 被 `workspace.sessionIds` 的 cwd 过滤挡住；改为无条件幂等 detach（move 两处 + session 删除），补回归测试（断言源工作区**记录**里不残留）；另加 `repair-duplicates.mjs` 修复已产生的坏数据 |
| 2026-11-12 | M4-3 关键验证：真实 DSH 0.2.2-rc.1 隔离实例跑通删除/恢复 | 从 `app.asar` 提取 runtime → `DSH_HOME=.test-tmp/live-home dsh --profile web --port 56832` → 种入工作区+会话 → `plan(mode=project, sessions=1)` → `move`（目录进 bin、manifest done）→ `restore`（日志回位、attach 成功、bin 清空）；另一个工作区因 UI 持有会话返回 `session-busy` |
| 2026-11-12 | M4-3 部分执行：已把插件链进 desktop profile（依赖 + bundles + node_modules 软链），预检通过；未重启 DSH | `node scripts/check-profile.mjs`：bundles/dependency/linked 全 true；备份文件 `package.json.bak-before-workspace-bin`、`pnpm-lock.yaml.bak-before-workspace-bin` |
| 2026-11-12 | M4-3 文档与预检落地：INSTALL.md（安装/验收/回滚）、CHANGELOG.md、LICENSE、check-profile.mjs | `node --test`：84 个用例全绿；预检脚本只读，默认 profile 下正确报「未安装」 |
| 2026-11-12 | M4-2 收尾：隐藏子代理随迁（同目录）+ 异地子代理告警 + 无 sessions 服务降级测试 + 包清单校验 | `node --test`：84 个用例全绿；子代理会话进 bin 后能随工作区恢复并重新挂回 |
| 2026-11-12 | M4-1 崩溃注入落地：7 个阶段 SIGKILL + 恢复断言；M4-2 补嵌套工作区告警 | `node --test`：79 个用例全绿；`node scripts/crash-injection.mjs` 7/7 通过 |
| 2026-11-12 | M3-3 拖拽搬移落地：`installDrag` + 分组判定 + 高亮 + 大日志护栏（256MB） | `node --test`：78 个用例全绿；拖拽用假 DOM 跑真实事件顺序，断言跨组接管、自己组让路、drop 载荷正确 |
| 2026-11-12 | M3-2 跨区移动事务落地：`move.js`（暂存区 + journal + 后继 artifact + 读回校验 + 启动恢复）、`relocate` 端点 | `node --test`：73 个用例全绿；`node scripts/m3-move-e2e.mjs` 走完 relocate；归属失败留 `committed` 日志待重启补齐 |
| 2026-11-12 | M3-1 单会话删除/恢复落地：`session.js`、路由按 payload 分流、会话菜单项、`kind: session` 清理与恢复 | `node --test`：61 个用例全绿；`node scripts/m3-session-e2e.mjs` 走完 plan→move→list→restore；启动恢复补上了会话条目分支 |
| 2026-11-12 | M2 客户端落地（菜单 / 页脚 / 面板 / 确认框 / 文案 / 样式） | `node --test`：51 个用例全绿；`client.js` 在假 loader + 假 ctx 上验证了 `contextMenus`（target=workspace、order=310、item 形状）、三个 slot、zh/en 词典键一致；轻量渲染冒烟能展开页脚、空面板和待确认对话框。真机视觉验收待 M4-3 |

剩余唯一任务：**M4-3 真机验收**（装进 desktop profile → 重启 → 菜单/面板/拖拽/恢复走一遍）。这一步要写 `~/.dsh` 并重启 DSH，等 Boss 批准，不自动执行。
