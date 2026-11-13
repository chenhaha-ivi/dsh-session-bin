# dsh-workspace-bin

DSH 会话回收站 + 跨区拖拽：单会话删除先进回收站（可恢复、可永久删除），会话可以拖到另一个工作区。
工作区的「删除工作区」直接用 DSH 自带的按钮——本插件不再往工作区菜单里塞第二个删除项。

> 适配 DSH **0.2.2-rc.1**（desktop profile）。只走公开 API，不改 `app.asar`、不改核心包。
> 安装与真机验收：见 [INSTALL.md](INSTALL.md)；版本变化：见 [CHANGELOG.md](CHANGELOG.md)。

## 现在能做什么

- 会话右键菜单 →「回收会话」：单个会话连同目录进回收站；恢复后回到原工作区，原工作区没了就落在未分组。
- 会话跨工作区移动（Host 接口 `relocate`）：停活 → 暂存区 park → 用后继 artifact 重建到目标 cwd → 读回校验 → 删源 → 改归属。
- 拖拽搬移：把会话行拖到别的工作区分组上，分组高亮、松手即搬；落在自己分组完全让路，不抢官方排序。
- 侧栏页脚 →「回收站 (N)」：面板里逐条 **恢复** / **永久删除**，底部 **清空回收站**（二次确认）。
- 回收站持久化在 `<DSH_HOME>/workspace-bin/<entryId>/`，重启后仍在；启动恢复只收敛
  `planned` 条目，**绝不自动删字节**。
- 回收会话时：活会话先停（最多 3 秒），停不下来就整体拒绝、一个字节不动。
- 工作区删除交给 DSH 自带的「删除工作区」；插件监听删除事件，把工作区文件夹一起送进系统回收站（见上一节），
  会话日志仍留在 DSH 的 sessions 目录里（官方语义）。

## 官方「删除工作区」→ 本地目录进系统回收站

- 插件监听 Host 的 `domain/changed`：用户在官方入口确认删除后，把该工作区的**本地文件夹**
  移进操作系统回收站（macOS 废纸篓 / Windows 回收站）。
- macOS 先把目录 `rename` 进 `~/.Trash`（目标确定、Finder 可见；重名加时间后缀），跨卷才交给
  Electron 的 `shell.trashItem`；其它平台用 Electron，拿不到就明确拒绝，绝不 `rm -rf`。
- 每次搬移/跳过/失败都追加到 `<DSH_HOME>/workspace-bin/os-trash.log`，方便对账。
- 只对**官方入口**生效：插件自己的工作区事务会 `suppress`，只搬会话、不碰目录。
- 保护区会跳过并记日志：DSH home、会话存储根、宿主进程 cwd、别的嵌套工作区的祖先目录。
- 不需要时在配置里写 `trashWorkspaceFolder: false` 关闭。

## 安装（本地目录）

```bash
# 1. 把本仓库链进 desktop profile 的依赖（不要复制，方便改）
cd ~/.dsh/profiles/desktop
pnpm add link:/Users/chenming/Documents/dsh-workspace-bin

# 2. 在 profile package.json 的 dsh.profile.bundles 里加一行 "dsh-workspace-bin"
#    然后重启 DSH（插件在启动时加载）
```

装完后：侧栏页脚出现「回收站」，会话右键菜单出现「放入回收站」。
卸载：从 `dsh.profile.bundles` 里删掉那一行并重启；回收站目录不会被自动清理（可以手动删，
但那就是真删字节了）。

> 与 `dsh-plugin-session-purge` 功能有重叠（那是会话回收站），建议二选一。

## HTTP 接口

单路由 `POST /api/workspace-bin`，请求 `{ "endpoint": "...", "payload": {...} }`：

| endpoint | payload | 作用 |
|---|---|---|
| `plan` | `{ sessionId }` | 调查一次会话删除会动什么（不执行） |
| `move` | `{ sessionId }` | 执行会话删除到回收站 |
| `list` | `{}` | 回收站内容 + 损坏条目 |
| `restore` | `{ entryId }` | 恢复一个条目 |
| `empty` | `{ entryIds? }` | 永久删除（缺省清空） |
| `relocate` | `{ sessionId, targetWorkspaceId \| targetPath }` | 会话跨工作区移动 |

成功 `{ "ok": true, "value": ... }`；失败 `{ "ok": false, "error": { code, message, details } }`。

工作区级 `plan/move` 的 Host 事务仍保留，只用于恢复旧版本留下的工作区条目和跑内部回归，UI 不再暴露。

## 开发

```bash
node --test          # 全部单测（fake DSH home，写在 .test-tmp/）
node scripts/m1-e2e.mjs          # 工作区端到端：plan → move → list → restore → move → empty
node scripts/m3-session-e2e.mjs  # 单会话端到端：plan → move → list → restore
node scripts/m3-move-e2e.mjs     # 跨区移动端到端：relocate + 读回校验
node scripts/crash-injection.mjs # 崩溃注入：在 7 个阶段 SIGKILL，再断言恢复收敛
node scripts/extract-runtime.mjs # 从已安装 DSH 提取 runtime，供隔离实例自测
node scripts/verify-live.mjs     # 只读验活：确认运行中的 DSH 挂上了 /api/workspace-bin
```

测试只写 `.test-tmp/`，不碰真实 `~/.dsh`。

## 如果会话同时出现在两个工作区

0.1.0 的跨区移动有一个已修复的 bug：改完 header 后判断要不要从源工作区摘除时被 cwd 过滤挡住，
源记录里会残留同一个会话 id。**DSH 启动时会把「一个会话被两个工作区记账」判成损坏并拒绝启动**，
所以先修数据再重启：

```bash
node scripts/repair-duplicates.mjs          # dry-run：保留 header.cwd 所属的工作区
node scripts/repair-duplicates.mjs --apply  # 备份 workspace.json 后写回
```

修完重启 DSH（新版本的 host.js 也已经修好，不会再产生重复）。

## 已知边界

- 真宿主安装与真机验收还没有跑（需要写 `~/.dsh` 并重启 DSH）。
- 会话级删除/恢复（M3-1）、跨区移动事务（M3-2）、拖拽搬移（M3-3）都已实现；拖拽只在假 DOM 上验过事件契约，真浏览器 CDP 验收还没跑。
- 移动一次最多读 256MB 日志；超过会直接拒绝而不是把进程拖死。
- 恢复旧的工作区条目要求工作区目录仍存在；目录没了就只把会话放回原项目目录（侧栏里显示为未分组）。
- 工作区删除后 DSH 自带的行为是「只移除登记」：文件夹和会话都保留，会话会落到「未分组」——这是官方语义，不是本插件。
