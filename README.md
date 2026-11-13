# dsh-workspace-bin

DSH 的会话回收站：删掉的会话先放进来，能恢复、也能彻底删；会话还能直接拖到别的工作区。

> 适配 DSH **0.2.2-rc.1 / rc.2**（desktop profile），只走公开 API，不改 `app.asar`、不改核心包。
> 安装与验收：[INSTALL.md](INSTALL.md) · 版本变化：[CHANGELOG.md](CHANGELOG.md) · 开发与内部实现：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## 能做什么

- **删会话先进回收站**：会话「…」菜单 →「回收会话」；也可以把会话行直接拖到侧栏页脚的「回收站」入口。
  两条路都先给确认框（会话数、大小、是否还在回复），不会不经确认直接删。
  恢复后回到原工作区；原工作区没了就落在「未分组」。
- **回收站面板**：页脚「回收站 (N)」→ 逐条 **恢复** / **永久删除**，底部 **清空回收站**（二次确认）。
  条目跨重启保留，不会在启动时被自动清理。
- **把会话拖到别的工作区**：拖到目标分组松手即搬，目标分组高亮；落在自己分组不接管，官方组内排序照旧。
  搬完的位置跟插入线走：落在某行上下就插到它前后，落在目录或空白就放到末尾。
- **删工作区**：用 DSH 自带的「删除工作区」，插件不往菜单里塞第二个删除项。
- **不会悄悄删字节**：只有「永久删除」和「清空回收站」会真删，两者都要二次确认；
  会话还在回复就先停（最多 3 秒），停不下来就整体拒绝。

## 安装

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/Users/chenming/Documents/dsh-workspace-bin

# 然后在 profile 的 package.json 里给 dsh.profile.bundles 加一行 "dsh-workspace-bin"
# 重启 DSH
```

装完：侧栏页脚出现「回收站」，会话「…」菜单出现「回收会话」。
卸载：从 `dsh.profile.bundles` 删掉那一行并重启；回收站目录不会自动清理（手动删就是真删字节）。
完整步骤、逐项验收和回滚方式见 [INSTALL.md](INSTALL.md)。

> 与 `dsh-plugin-session-purge` 功能重叠（都是会话回收站），建议二选一。

## 可选：删工作区时把本地文件夹放进系统回收站

这个能力**默认关闭**，保持 DSH 官方语义：只移除工作区登记，文件夹和会话都保留。
要开启，在 profile 的 `cordis.patch.yml` 里给插件行加配置：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: workspace-bin
  config:
    trashWorkspaceFolder: true
```

开启后，用官方入口删除工作区时，本地文件夹会进系统回收站（macOS 放废纸篓、Finder 可见）。
DSH home、会话存储根、宿主进程 cwd、其它嵌套工作区的祖先目录会跳过并记日志；
拿不到系统回收站能力时明确拒绝，绝不 `rm -rf`。
每次搬移 / 跳过 / 失败都记在 `<DSH_HOME>/workspace-bin/os-trash.log`。

## 回收站放在哪

`<DSH_HOME>/workspace-bin/<entryId>/`，每个条目一个目录，`manifest.json` 是唯一清单。
要恢复就回到面板点「恢复」；直接删目录等于放弃恢复。

## 运行中的会话

- 正在跑回合（官方 agent 状态为 `running`）的会话在 **UI 层直接禁用**：菜单「回收会话」灰掉、
  拖拽被取消（原生拖拽也不启动），拖到回收站/其它工作区都不会发生。
- Host 侧同样拒绝（`workspace-bin/session-running`），防止绕过 UI 的调用。
- 打开着但空闲的会话仍可安全停活后搬运，不会打断任何回合。
- 后台任务是否算「运行中」取决于官方 agent 状态：回合结束后 agent 变 idle，此时可以搬。

## 已知限制

- 恢复旧的工作区条目要求原目录还在；目录没了就只把会话放回原项目目录（显示为未分组）。
- 会话带子代理时，只有同一项目目录下的子代理跟着搬；cwd 在别处的会留下，并在确认框里点名。
- 一次移动最多读 256MB 日志，超过直接拒绝，而不是把进程拖死。
- Windows 的写锁行为未实测。
- 面板一次显示 40 条，更多要点「显示更多」。

## 会话同时出现在两个工作区？

0.1.0 的跨区移动有个已修复的 bug，会让同一条会话被两个工作区记账，
而 DSH 启动时会把这种数据判成损坏并拒绝启动。历史数据先修再重启（在仓库根目录执行）：

```bash
node scripts/repair-duplicates.mjs          # dry-run：保留 header.cwd 所属的工作区
node scripts/repair-duplicates.mjs --apply  # 备份 workspace.json 后写回
```

修完重启 DSH。新版本不会再产生重复。
