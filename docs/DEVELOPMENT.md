# 开发与内部实现

面向维护者。用户安装与使用见 [README](../README.md)、[INSTALL](../INSTALL.md)；
面向用户的版本变化见 [CHANGELOG](../CHANGELOG.md)。更细的逐次改动看 `git log`。

## 代码结构

| 路径 | 作用 |
|---|---|
| `host.js` → `src/host/index.js` | Host 入口：读配置、装配 runtime 与路由 |
| `src/host/trash.js` | 回收站存储：目录布局、manifest、状态机、扫描 |
| `src/host/move.js` | 会话跨工作区移动事务与崩溃恢复 |
| `src/host/session.js` | 单会话删除 / 恢复事务（停活与驱逐交给 runtime） |
| `src/host/workspace.js` | 工作区级事务，只服务旧条目与内部回归，UI 不暴露 |
| `src/host/workspace-watch.js` | 监听 `domain/changed`，官方删除工作区后清理本地目录（默认关闭） |
| `src/host/os-trash.js` | 系统回收站：macOS `~/.Trash` 优先，Electron `shell.trashItem` 兜底 |
| `src/host/paths.js` | projectKey、目录编码、projectKey 碰撞检测 |
| `src/host/routes.js` | `POST /api/session-bin` 单路由（鉴权由 connection 围栏负责） |
| `src/host/runtime.js` | 停活/驱逐探针、会话存储根、路径状态；被三组 ops 共用 |
| `client.js` | 客户端 UI：菜单项、页脚入口、面板、拖拽、提示 |

## 配置

`host.js` 导出 `Config`（Standard Schema 的 `~standard.validate`，不引入 schema 依赖）：
`home`（非空字符串，缺省不覆盖）与 `trashWorkspaceFolder`（布尔，缺省 `false`）。
cordis 在激活前校验，未知键/类型错误会直接报 ValidationError；`apply` 只读取规范化后的值。

## HTTP 接口

单路由 `POST /api/session-bin`，请求 `{ "endpoint": "...", "payload": {...} }`：

| endpoint | payload | 作用 |
|---|---|---|
| `plan` | `{ sessionId }` | 调查一次会话删除会动什么（不执行） |
| `move` | `{ sessionId }` | 执行会话删除到回收站 |
| `list` | `{}` | 回收站内容 + 损坏条目 |
| `restore` | `{ entryId }` | 恢复一个条目 |
| `empty` | `{ entryIds? }` | 永久删除（缺省清空） |
| `relocate` | `{ sessionId, targetWorkspaceId \| targetPath }` | 会话跨工作区移动 |

成功 `{ "ok": true, "value": ... }`；失败 `{ "ok": false, "error": { code, message, details } }`。

工作区级 `plan/move` 的 Host 事务仍保留，只用于恢复旧版本留下的工作区条目和跑内部回归，
UI 不再暴露。

## 回收站存储

布局（`<DSH_HOME>/session-bin/`）：

```
<entryId>/                     # yyyyMMddTHHmmss-<6hex>，字典序即时间序
  manifest.json                # 唯一的事实来源，先写后搬
  sessions/<projectKey>/<sessionId>/
```

- **manifest 才是清单**：目录只是数据。恢复 / 清空 / 启动恢复都只信 manifest，
  再按磁盘实际是否存在决定「回滚」还是「补完」。
- **原子写**：同目录临时文件 + fsync 再 rename 覆盖，崩溃只会看到旧或新的完整 JSON。
- **状态机只往前走**：`planned → done | failed`，终结状态不再改，同状态重写幂等。
- **扫描绝不删东西**：坏 manifest 只报告，不清理。
- **根目录只改一次名**：0.4.x 的 `<DSH_HOME>/workspace-bin/` 在 `createBin` 时整目录 rename 过来
  （`migrateLegacyRoot`）；新目录已存在就不碰旧的，改名失败退回旧目录继续读写。
  manifest 不存回收站根的绝对路径，所以条目不用重写。
- 条目字节数在删除完成时写进 manifest 的 `size`，`list` 直接读；
  老条目首次 `list` 统计一次并回写缓存。

## 会话删除事务

1. `plan` 只读调查：会话目录、大小、是否活、是否会留下子代理；
2. 停活：先拆 `SessionStore` 条目，再 `agents.detachEntered()` 驱 agent；最多等 3 秒，
   任一步失败整体拒绝，一个字节不动；
3. 写 `planned` manifest；
4. 搬目录进回收站条目；
5. 从工作区登记里 detach（按持久记录、幂等），必要时补发 `api-session/removed`；
6. 写 `done`。中途崩溃由启动恢复按「文件已进 bin / 登记已删」收敛。

永久删除（`empty`）是唯一删字节的入口，必须二次确认。

## 跨区移动事务

会话目录名由 header 的 cwd 推导，cwd 变了目录必须跟着变；zstd 已提交帧又不允许改写。
所以不能就地改 header，只能「用后继 artifact 重建」：

1. 停活，确认没有写句柄；
2. 读源日志 header + 全部已提交事件；
3. 源目录 rename 到 `<sessionsRoot>/_session-bin-staging/<opId>/`
   （比正式目录深一层，后端扫描器看不见），保证同一 id 不会同时在两个项目目录；
4. `sessionPersistence.create({...header, cwd: target})` + `append` + `flush`；
5. 读回校验事件条数、末 seq、header.cwd，通过才删暂存区源目录；
6. 刷新 header 索引 → attach 目标工作区 → detach 源工作区；
7. 删投影缓存、清暂存区与日志。

0.4.x 的 `_workspace-bin-staging` 在 `recoverMoves()` 前整体并到 `_session-bin-staging`
（`adoptLegacyStaging`），升级前崩在搬移中途的会话仍按原 journal 补完或回滚。

每个阶段崩溃都能收敛：暂存区带 journal（`fromCwd`/`toCwd`/`sessionId`），启动时
`recoverMoves()` 按「目标 artifact 是否可用」决定补完或回滚，**目标未通过读回校验绝不删源字节**。

投影缓存（`session_projcache`）改为保留记录、只把 `identity.cwd` 指到新目录，
事件一条不改，标题与统计继续有效；记录缺失或写失败才退回删除。
移动后按落点写官方 view store 的 manual order：落在会话行上插到该行前/后，
落在目录或空白追加到末尾，侧栏切到「手动排序」。

> 历史 bug：`detachSession` 曾被 `workspace.sessionIds` 的 cwd 过滤挡住，
> 导致同一会话被两个工作区记账，DSH 启动时判损坏。现按持久记录无条件 detach（幂等）。
> 已有坏数据用 `scripts/repair-duplicates.mjs` 修（会先备份 `workspace.json`）。

## 官方「删除工作区」后的目录清理

默认关闭，`config.trashWorkspaceFolder === true` 才监听 `domain/changed`：

- 只认官方入口；插件自己的工作区事务会 `suppress`，只搬会话、不碰目录；
- macOS 先 `rename` 进 `~/.Trash`（重名加时间后缀），跨卷才交给 Electron；
  其它平台用 Electron，拿不到就明确拒绝，绝不 `rm -rf`；
- 保护区跳过并记日志：DSH home、会话存储根、宿主进程 cwd、别的嵌套工作区的祖先目录；
- 每次搬移/跳过/失败追加到 `<DSH_HOME>/session-bin/os-trash.log`（含 `via`/`target`/失败原因）。

## 一致性验证

- `node --test`：136 个用例（fake DSH home，全部写 `.test-tmp/`）。
- `scripts/crash-injection.mjs`：在删除/移动流程 8 个阶段 SIGKILL，断言恢复后
  文件、归属、回收站三者最终一致。
- 隔离实例 + 真浏览器（0.2.2-rc.1）：冷会话删除无「未分组」、恢复回原分组、
  打开中的会话跨区移动、`move` 在会话被 UI 持有时返回 `session-busy`。
- 45 条目实例：面板首屏 40 行、「显示更多」递增到 45。

## 开发命令

```bash
node --test                       # 全部单测（fake DSH home，写在 .test-tmp/）
node scripts/m1-e2e.mjs           # 工作区端到端：plan → move → list → restore → move → empty
node scripts/m3-session-e2e.mjs   # 单会话端到端：plan → move → list → restore
node scripts/m3-move-e2e.mjs      # 跨区移动端到端：relocate + 读回校验
node scripts/crash-injection.mjs  # 崩溃注入：8 个阶段 SIGKILL 后断言恢复收敛
node scripts/extract-runtime.mjs  # 从已安装 DSH 提取 runtime，供隔离实例自测
node scripts/verify-live.mjs      # 只读验活：确认运行中的 DSH 挂上了 /api/session-bin
node scripts/check-profile.mjs    # 安装前预检：profile 清单、软链、engines
node scripts/rename-checkout.mjs  # 改名升级：旧包 0.4.x 的目录/依赖 → dsh-session-bin（--apply 才真改）
node scripts/repair-duplicates.mjs # 修「同一会话被两个工作区记账」的历史数据
```

测试只写 `.test-tmp/`，不碰真实 `~/.dsh`。

## 发布检查单

1. `node --test` 全绿，再跑三个 e2e 与 `crash-injection`；
2. `package.json` 的 `version` 与 CHANGELOG 顶部节点一致（改名后从 0.1.0 重新起，不续旧包号）；
3. 展示资源齐全：`locale/{zh,en}.json` 的 `meta.title` / `meta.description` / `meta.detail` 指向存在的
   `docs/DETAIL*.md`，详情页只放 `docs/preview.svg` 一张图（640×300，无文字、脚本、外链）；
   `test/manifest.test.mjs` 会挡住漏项；
4. CHANGELOG 只写用户能感知的变化，实现细节留在本文件；
5. `npm pack --dry-run` 确认 `files` 覆盖 host/client/src/icon/locale/docs/三份文档；正式产物用
   `npm pack --pack-destination dist`，记 sha256，并解包跑 `import('./host.js')` 与资源校验；
6. 打 annotated tag：`git tag -a v0.1.0 -m "dsh-session-bin 0.1.0"`（0.1.0 是改名后首个版本，旧包不补 tag）；
7. `npm publish --registry=https://registry.npmjs.org`：本机默认 registry 是 npmmirror，必须显式覆盖；
   账号是 `auth-and-writes` 2FA，发布会要 OTP。完整步骤与回滚见 [RELEASE.md](../RELEASE.md)。

## 已知工程边界

- 一次移动把整段日志读进内存再 append，上限 256MB，超过直接拒绝。
- Windows 尚未真机验证；`.github/workflows/windows.yml` 跑单测与三个 e2e，
  `crash-injection` 依赖 SIGKILL，在 Windows 上自动跳过。
- 跨区移动只搬被拖的单条会话；子代理会话不随迁，会留在原工作区（Host 的工作区删除事务
  会收集同项目子代理，但当前 UI 不暴露工作区删除）。
- 恢复旧的工作区条目会新建登记（工作区 id 变化），要求原目录仍存在。
- projectKey 碰撞时降级为逐会话处理；嵌套工作区会告警。
