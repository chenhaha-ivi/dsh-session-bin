# dsh-workspace-bin — 工作区回收站 + 会话跨区拖拽

> 方案初稿 v0.1 · 目标宿主 DSH 0.2.2-rc.1（desktop profile）
> 这份文件是给"新工作区里的新会话"开工用的起点，不是最终版。

## 1. 需求

- R1：删除工作区 = 工作区记录 + 它名下全部会话，一起进**回收站**，不立刻删字节。
- R2：回收站**持久化**。重启 DSH 后数据仍在；只有用户显式「永久删除 / 清空回收站」才真删。
- R3：会话可以跨工作区移动，交互是**拖拽**：把会话行拖到目标工作区分组上。
- R4：参考现有插件，只走公开 API，不改 `app.asar`、不改核心包。

## 2. 参考实现

| 插件 | 借什么 |
|---|---|
| dsh-plugin-session-purge | 两段式回收站、`plan/move/list/restore/empty` 五个端点、停活 + 驱逐运行时、目录即清单、`/api` 精确路由的注册方式 |
| dsh-session-relocate | 跨工作区搬会话的路径算法（projectKey / encodeSegment）、staging 深一层、迁移日志与崩溃恢复、侧栏拖拽交互 |
| dsh-workspace-control | 用 `sessionPersistence.create({...header, cwd})+append()+flush()` 生成后继 artifact、park 源目录、读回校验、清理 registry 的 cwd 缓存索引 |
| dsh-sidebar-row-menu | 删工作区+会话的顺序（先逐个删会话，全成功才删登记，失败保留可重试）、0.2.2 工作区菜单的注册方式 |

## 3. 结构

包名 `dsh-workspace-bin`，Host 半边 + Client 半边。

Host 注入：`workspaceRegistry`、`sessionPersistence`、`storageDomain`、`sessions`、`agents`、`sessionController`、`connection`、`logger`。

```
dsh-workspace-bin/
  package.json            # dsh.bundle.patch + dsh.client.inject，platform: web
  cordis.patch.yml
  host.js                 # 或 src/host/index.js
    trash.js              # 回收站目录、manifest、状态机、启动恢复
    workspace.js          # 删除 / 恢复 / 永久删除工作区
    session.js            # 删除 / 恢复会话、跨区移动事务
    routes.js             # /api/workspace-bin 的 plan/move/list/restore/empty
  client.js               # 菜单、回收站面板、拖拽
  locale/zh.json, en.json
  test/*.test.mjs
```

## 4. 回收站数据模型

```
<DSH_HOME>/workspace-bin/
  <entryId>/
    manifest.json
    sessions/<projectKey>/<sessionId>/session.vN.jsonl.zstd
```

`entryId = yyyyMMddTHHmmss-<6hex>`。manifest：

```json
{
  "version": 1,
  "kind": "workspace" | "session",
  "createdAt": "ISO",
  "state": "planned" | "done" | "failed",
  "workspace": { "id": "...", "path": "...", "title": "...", "createdAt": "...", "updatedAt": "..." },
  "projectKey": "--Users-...--",
  "sessions": [{ "id": "session-...", "title": "...", "archived": false, "pinned": false }]
}
```

**关键简化**：同一工作区的会话共享同一个 `cwd`，因此共享同一个 `projectKey`、共享同一个项目目录。删工作区时**整目录一次 rename** 进回收站，原子、可回滚，不用逐个搬。

碰撞：`projectKey` 映射是有损的（`/a-b` 与 `/a/b` 可能同键）。删之前检查是否还有**别的路径**也映射到同一个 projectKey；有则降级为逐会话 rename。

## 5. 删除工作区（事务）

1. 门禁：调用方会话不在目标集合里；工作区存在；目录可读；活会话逐个 `cancel` 并等 ≤3s 停下，`detachEntered` 驱逐运行时；被打开但空闲的会话先释放，释放不了就拒绝。
2. 写 `manifest.json`（`state: planned`），fsync。
3. `rename(<sessionsRoot>/<projectKey>, <bin>/<entryId>/sessions/<projectKey>)`。
4. `workspaceRegistry.delete(id)`；把该会话从全局 `archivedSessionIds` / `pinnedSessionIds` 里摘掉，并记进 manifest。
5. `state: done`，通知客户端刷新。

失败回滚：rename 回去 → `registry.create(path)` + 逐个 `attachSession` → `state: failed`。
崩溃恢复：启动时扫回收站，`planned` 的条目按"源目录还在就回滚、已进回收站就补完登记删除"处理；**绝不自动删字节**。

## 6. 删除单个会话

停活 → detach → 会话目录 rename 进回收站（`kind: session`）→ 从工作区成员表 `/` 归档置顶集合摘除 → done。
恢复：rename 回原项目目录 → `resolveByPath(cwd)` 找到工作区 → `attachSession`（cwd 没变，不需要重建 header）→ 恢复归档/置顶标记。

## 7. 恢复

- 工作区：目录 rename 回 → `registry.create(path)`（目录必须存在；不存在则只恢复会话并提示"工作区目录缺失"）→ 逐个 `attachSession` → 还原归档/置顶 → 删除回收站条目。
- 会话：同 R6，恢复后回到原工作区；原工作区不存在时进「未分组」。

## 8. 永久删除

只有这一个动作删字节：`rm -rf <bin>/<entryId>`，并删掉 `session_projcache` 里对应的会话条目。启动、列表、恢复都**不会**清回收站。

## 9. 会话跨区移动（拖拽）

事务（参考 dsh-workspace-control，MIT）：

1. 停活 + `detachLive`，确认 `sessionPersistence.stat(id)` 不再被持有。
2. 读 header + 已提交事件（`open(id,'read')`）。
3. 把源会话目录 park 到 `<sessionsRoot>/_workspace-bin-staging/<opId>/<encodedId>/`（比正式目录深一层，后端扫描器看不见）。
4. `sessionPersistence.create({...header, cwd: target}, { inheritedEventCount })` → `append(events)` → `flush()`。
5. 读回校验：事件条数、`lastSeq`、`cwd`。校验通过才删 parked。
6. registry 的 cwd 缓存索引（`headers` / `sessionPaths` 两个私有 Map）清掉这条会话 → 旧工作区 `detachSession` → 新工作区 `attachSession`。私有字段要特性探测，失败就提示"重启后自动补归属"。
7. 删 `session_projcache` 里这条会话的条目（标题/统计会重建）。

失败回滚：删后继 → rename parked 回去 → 报错。
**不改写已提交的 zstd frame**（格式禁止"committed events are never rewritten"），一律用后继 artifact 重建。

## 10. 客户端

- 工作区菜单：`ctx.get('contextMenus').register({ target: 'workspace', order: 310, ... })` →「删除到回收站…」
- 会话菜单：slot `sidebar.workspaces.session.menu.item`，order 500 →「放入回收站」
- 侧栏页脚：slot `sidebar.footer.action` →「回收站 (N)」
- 回收站面板：slot `shell.overlay`；分组「工作区 / 会话」；每行 恢复 / 永久删除；底部 清空回收站
- 拖拽：会话行 `dragstart` 带上 sessionId；工作区分组 `dragover` 高亮、`drop` 调 `move`；支持多选批量（可选）
- 确认框：列会话数、总大小、目标路径、会被停掉的运行中回合

## 11. 不做的事

- 不删工作区目录本身；不删 `~/.dsh/attachments`（内容寻址、共享）。
- 不在启动时自动清回收站。
- 不劫持核心「删除工作区」按钮，只加自己的菜单项。
- 不写 `app.asar`；私有索引清理是唯一"越界"点，带探测和降级。

## 12. 已知坑

1. `WorkspaceRegistry` 只在启动时建 cwd 索引，move 后 `attachSession` 会被旧 cwd 拒绝 → 清缓存，或提示重启。
2. 同一个 session id 同时存在两个 artifact = 日志被判 corrupt → 必须先 park 再 create。
3. zstd 已提交事件不能改 → 只能后继重建。
4. 活会话 / 被打开会话持有句柄（Windows 上尤其）。
5. `projectKey` 有损 → 碰撞检测，必要时逐会话。
6. 归档会话仍占 `sessionIds` 槽位；恢复后要保持归档状态。
7. 子代理 / 分叉：删工作区时整目录一起走；移动时可提供「连同子会话」开关。
8. 嵌套工作区：删外层会让内层悬空，确认框要警告。
9. 大日志移动要空间和时间，拖拽要进度反馈。
10. 恢复要求工作区目录仍存在，否则只能退回「未分组」。

## 13. 里程碑

- **M1** 回收站存储 + 删/恢复/清空工作区 + `/api/workspace-bin` 端点 + 单测（无 UI，用 curl 驱动）
- **M2** 客户端菜单 + 回收站面板
- **M3** 单会话删除 + 跨区移动事务 + 拖拽
- **M4** 崩溃恢复、碰撞/嵌套、批量、真机验收、README

## 14. 测试

- 单测（fake `DSH_HOME`）：projectKey、manifest 状态机、rename 事务、restore、empty、幂等、碰撞降级。
- 真机：拿一个废弃工作区走完整流程；重启验证回收站还在；恢复后会话能打开继续聊；拖拽移动后会话在新工作区能继续。
- 破坏性：删除中途 `kill -9`，重启看 recover 是否能回滚/补完。

## 15. 兼容

- `engines.dsh: >=0.2.2-rc.1 <0.3.0`，Node >= 22。
- 安装：插件页添加包名，或本地目录 `link:`；装完重启。
- 与 `dsh-plugin-session-purge` 功能重叠（会话回收站），建议二选一；不要和 `dsh-workspace-control` 的 move 同时用。

## 16. 下一步

1. 补 `package.json` / `cordis.patch.yml` 骨架。
2. 按 M1 写 Host 侧（先能做「删工作区进回收站 / 恢复 / 清空」）。
3. 在 fake home 上跑通，再上真机。
