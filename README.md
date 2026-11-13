# dsh-session-bin

DSH 的会话回收站：删掉的会话先放进来，能恢复、也能彻底删；会话还能直接拖到别的工作区。

> 当前版本 **0.1.0**：包从 `dsh-workspace-bin` 改名为 `dsh-session-bin`，版本号重新起算。
> 适配 DSH **0.2.2-rc.1 / rc.2**（desktop profile），通过 DSH 的服务扩展点工作，不改 `app.asar`、不改核心包；
> 少数官方索引字段与侧栏 DOM 约定是探测式读取，升级 DSH 后需要回归。
> 安装与验收：[INSTALL.md](INSTALL.md) · 版本变化：[CHANGELOG.md](CHANGELOG.md) · 发布清单：[RELEASE.md](RELEASE.md) · 开发与内部实现：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · 源码：[GitHub](https://github.com/chenhaha-ivi/dsh-session-bin)

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

从 npm 装（发布后，推荐）：

```bash
dsh plugin --profile desktop add dsh-session-bin
```

从本地仓库链接装（开发、或 npm 上还没有这个版本时）：

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:<仓库根目录>      # 例如 ~/Documents/dsh-session-bin

# 然后在 profile 的 package.json 里给 dsh.profile.bundles 加一行 "dsh-session-bin"
# 重启 DSH
```

装完：侧栏页脚出现「回收站」，会话「…」菜单出现「回收会话」。
卸载：`dsh plugin --profile desktop remove dsh-session-bin`（或从 `dsh.profile.bundles` 删掉那一行）并重启；
回收站目录不会自动清理（手动删就是真删字节）。
完整步骤、逐项验收和回滚方式见 [INSTALL.md](INSTALL.md)。

> 0.1.0 的 npm 产物已打包、校验（`dist/dsh-session-bin-0.1.0.tgz`，见 [RELEASE.md](RELEASE.md)），
> `npm publish` 仍待执行；发布前请用上面的本地链接方式安装。

> **从旧包 0.4.x 升级**：仓库目录、profile 依赖和 `dsh.profile.bundles` 都换成新包名
> `dsh-session-bin`（版本号从 0.1.0 重新起），重启即可；回收站数据与暂存区会在首次启动时自动迁移。

> 与 `dsh-plugin-session-purge` 功能重叠（都是会话回收站），建议二选一。

## 可选：删工作区时把本地文件夹放进系统回收站

这个能力**默认关闭**，保持 DSH 官方语义：只移除工作区登记，文件夹和会话都保留。
要开启，在 profile 的 `cordis.patch.yml` 里给插件行加配置：

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: session-bin
  config:
    trashWorkspaceFolder: true
```

开启后，用官方入口删除工作区时，本地文件夹会进系统回收站（macOS 放废纸篓、Finder 可见）。
DSH home、会话存储根、宿主进程 cwd、其它嵌套工作区的祖先目录会跳过并记日志；
拿不到系统回收站能力时明确拒绝，绝不 `rm -rf`。
每次搬移 / 跳过 / 失败都记在 `<DSH_HOME>/session-bin/os-trash.log`。

配置由插件的 `Config` schema 校验：未知键、类型错误会在激活时报错，不会静默忽略。

| 配置键 | 默认 | 说明 |
|---|---|---|
| `trashWorkspaceFolder` | `false` | 官方删除工作区时是否把本地文件夹送进系统回收站 |
| `home` | 未设置 | 覆盖 DSH home（回收站根目录定位）；一般不要改，改错会让回收站换位置 |

## 回收站放在哪

`<DSH_HOME>/session-bin/<entryId>/`，每个条目一个目录，`manifest.json` 是唯一清单。
要恢复就回到面板点「恢复」；直接删目录等于放弃恢复。

旧包 0.4.x 的 `<DSH_HOME>/workspace-bin/` 会在首次启动时整目录改名过来，条目不用重写；
改名失败（跨卷、权限）就继续读写旧目录，不会让回收站看起来空了。

## 运行中的会话

- 正在跑回合（官方 agent 状态为 `running`）的会话仍可回收/搬移，但会先弹确认框；
  确认后先停回合（最多 3 秒），停不下来就整体拒绝（`session-bin/session-busy`），一个字节不动。
- 菜单「回收会话」、拖到页脚回收站、拖到其它工作区都走这条「先确认、再停」的路径。
- 打开着但空闲的会话仍可安全停活后搬运，不会打断任何回合。
- 后台任务是否算「运行中」取决于官方 agent 状态：回合结束后 agent 变 idle，此时可以搬。

## 已知限制

- 恢复旧的工作区条目要求原目录还在；目录没了就只把会话放回原项目目录（显示为未分组）。
- 条目里若有 manifest 未登记的会话目录（旧版本整目录搬移可能产生），恢复/永久删除会拒绝并保留数据；
  这类条目需要人工检查，不会自动删。
- 跨区移动只搬**当前选中的那一条会话**；它的子代理会话不会跟着搬，仍留在原工作区。
  （工作区删除的 Host 事务会收集同一项目目录下的子代理，但当前 UI 不暴露工作区删除。）
- 一次移动最多读 256MB 日志（按物理压缩大小判断），超过直接拒绝，而不是把进程拖死。
- 插件依赖 DSH 0.2.2 的若干服务索引字段与侧栏 DOM 约定（`data-row-key`、插入线类名）；
  升级到新的 0.2.x 后建议重跑一次 `node --test`、三个 e2e 和真机删除/恢复/拖拽。
- Windows 尚未在真机验证；仓库提供 `windows-latest` CI（[.github/workflows/windows.yml](.github/workflows/windows.yml)），
  会跑单测与三个 e2e。首次绿色之前，Windows 的写锁/rename 结论仍按未实测看待。
- 面板一次显示 40 条，更多要点「显示更多」。

## 会话同时出现在两个工作区？

0.1.0 的跨区移动有个已修复的 bug，会让同一条会话被两个工作区记账，
而 DSH 启动时会把这种数据判成损坏并拒绝启动。历史数据先修再重启（在仓库根目录执行）：

```bash
node scripts/repair-duplicates.mjs          # dry-run：保留 header.cwd 所属的工作区
node scripts/repair-duplicates.mjs --apply  # 备份 workspace.json 后写回
```

修完重启 DSH。新版本不会再产生重复。
