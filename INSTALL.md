# 安装与验收清单

> 这一步会写 `~/.dsh` 并重启 DSH。重启会结束当前正在跑的所有会话——请在**没有正在进行的对话**时做，
> 或者先确认这些会话可以中断。

## 0. 前置条件

- DSH **0.2.2-rc.1 / rc.2**（desktop profile），Node ≥ 22，pnpm 可用。
- 包在 `dsh-session-bin/` 下，`package.json` 的 `engines.dsh` 写着兼容范围。
- 如果装了 `dsh-plugin-session-purge`，先决定留哪个：两者都有会话回收站，功能重叠，建议二选一。

## 1. 安装

两种方式选一种。装之前先备份 profile 清单，出问题能原样退回去：

```bash
cd ~/.dsh/profiles/desktop
cp package.json package.json.bak-before-session-bin
```

### 方式 A：从 npm 安装（发布后，推荐）

```bash
dsh plugin --profile desktop add dsh-session-bin
cd <仓库根目录>
node scripts/check-profile.mjs
```

`dsh plugin add` 会自动把包加进 `dsh.profile.bundles`，不用手改清单。

### 方式 B：从本地仓库链接（开发时，改代码不用重装）

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:<仓库根目录>      # <仓库根目录> 例如 ~/Documents/dsh-session-bin

# 再在 package.json 的 dsh.profile.bundles 数组里加一行：
#    "dsh-session-bin"
#    （位置随意，建议放在 dsh-plugin-session-purge 附近）

cd <仓库根目录>
node scripts/check-profile.mjs
```

`check-profile.mjs` 会打印：profile 清单里有没有这个包、`node_modules` 的链指到哪
（npm 安装显示 `installedCopy`）、engines 是否匹配。全部 OK 再重启 DSH。

## 1.5 从旧包 0.4.x 升级（0.1.0 改名）

0.1.0 起把包名和插件 id 从 `workspace-bin` 改成了 `session-bin`，版本号也重新从 0.1.0 起算；
旧安装不会自动跟着走。先**退出 DSH**，再在 Terminal 里跑
（脚本会改名仓库目录、换 profile 依赖与 bundles、装依赖）：

```bash
cd ~
node ~/Documents/dsh-workspace-bin/scripts/rename-checkout.mjs          # 预演：只打印计划
node ~/Documents/dsh-workspace-bin/scripts/rename-checkout.mjs --apply  # 真改
```

不想用脚本也可以手工做同样的四步：

```bash
# 1. 退出 DSH，再把仓库目录改成新名字（路径要和下面的 link 一致）
mv ~/Documents/dsh-workspace-bin ~/Documents/dsh-session-bin

# 2. profile 里换包
cd ~/.dsh/profiles/desktop
pnpm remove dsh-workspace-bin
pnpm add link:<仓库根目录>
#    dsh.profile.bundles 里把 "dsh-workspace-bin" 换成 "dsh-session-bin"

# 3. 重启 DSH：首次启动会把 <DSH_HOME>/workspace-bin 改名为 session-bin
```

- 仓库目录同时是当前这个 DSH 工作区：改名后要在 DSH 里把新目录加为工作区，旧条目（指向老路径）删掉。
  这个工作区里已有会话的 cwd 仍记着老路径；要保留它们，先用插件的跨区移动搬到新工作区，再删旧条目。
- 回收站条目不用重写；迁移失败（跨卷、权限）时插件继续读写旧目录，不会清空回收站。
- 暂存区 `_workspace-bin-staging` 会在启动恢复时并到 `_session-bin-staging`，中途崩的搬移照样补完。
- 回退到 0.4.x：把 `~/.dsh/session-bin` 手工改回 `~/.dsh/workspace-bin`，再按旧包名重装。

## 2. 重启后的验收（按顺序做，每步都可回退）

| # | 动作 | 期望 |
|---|---|---|
| 1 | 打开侧栏 | 页脚出现「回收站」（初始没有计数） |
| 2 | 打开任意会话的「…」菜单 | 菜单里有「回收会话」；工作区菜单里**没有**插件加的删除项 |
| 3 | 点「回收会话」 | 确认框显示路径、大小、运行中状态、搬运方式；取消不发请求 |
| 4 | 拿一个**废弃会话**确认 | 确认后会话行消失；页脚计数 +1；回收站面板里出现该条目 |
| 5 | 面板里点「恢复」 | 会话行回到原分组、能打开继续聊；条目消失 |
| 6 | 再删一次，这次点「永久删除」 | 二次确认后条目消失；`<DSH_HOME>/session-bin` 下对应目录被删 |
| 7 | 再删一次，然后**重启 DSH** | 回收站条目还在（持久化），不会被启动清理 |
| 8 | 把一条会话从工作区 A 拖到 B | 目标分组高亮；松手后会话出现在 B；A 里消失 |
| 9 | 拖到自己所在分组 | 完全不接管（官方的组内排序照常工作） |
| 10 | 删除一个正在回答的会话 | 先停回合（最多 3 秒），停不下就拒绝并报错 |
| 11 | 先在 `cordis.patch.yml` 给 `session-bin` 配 `trashWorkspaceFolder: true`，再用临时工作区点官方「删除工作区」 | 文件夹进系统回收站（废纸篓里能看到），工作区从列表消失，会话进「未分组」；不配置时目录保持不动 |
| 12 | 用插件删一条会话 | 只动会话目录；它所属的工作区文件夹**不动** |

数据侧可以随时对照：

```bash
ls ~/.dsh/session-bin/                    # 每个条目一个目录，manifest.json 是唯一清单
cat ~/.dsh/session-bin/*/manifest.json    # state: planned/done/failed
ls ~/.dsh/sessions/_session-bin-staging/  # 正常应为空（或只有待恢复的 op）
```

## 3. 出问题时的回滚

```bash
cd ~/.dsh/profiles/desktop
# 1. 从 dsh.profile.bundles 里删掉 "dsh-session-bin"
# 2. 还原清单（二选一：手工删依赖，或用备份）
cp package.json.bak-before-session-bin package.json
pnpm install
# 3. 重启 DSH
```

- 回滚**不会**删回收站里的数据：`~/.dsh/session-bin` 还在。要清掉它需要手工 `rm -rf`，
  那就是真删字节了，先确认没有要恢复的东西。
- 如果重启后页面白屏：先把插件行注释掉重启，确认是插件问题；控制台里的报错会指出是
  `client.js` 加载失败还是 slot 注册失败。

## 4. 隔离实例自测（不碰 desktop profile）

不想动真实 profile 时，可以起一个独立实例：

```bash
cd <仓库根目录>      # 例如 ~/Documents/dsh-session-bin

# 1. 从已安装的 DSH 提取 runtime（只读 app.asar，写到 .test-tmp/）
node scripts/extract-runtime.mjs

# 2. 起一个独立 home + web 实例（自动初始化 profiles/web）
DSH_HOME="$PWD/.test-tmp/live-home" \
  node .test-tmp/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --port 56832 --no-open

# 3. 往 .test-tmp/live-home/profiles/web 里装插件（改 package.json 的 bundles + node_modules 软链）
#    然后重启实例，用 scripts/verify-live.mjs 验活：
node scripts/verify-live.mjs --url http://127.0.0.1:56832 --token <启动日志里的 token>
```

2026-11-12 已用这条路径在 0.2.2-rc.1 上跑通「删会话 → 列表 → 恢复 → 永久删除」与拖拽，
并确认「会话被 UI 持有且停不下来时，`move` 返回 `session-busy`」。

## 5. 已知限制

- Desktop profile 的 UI 验收（本清单 1~12 步）仍需人工执行；隔离实例只验证了 Host 路由与事务。
- 跨区移动一次最多读 256MB 日志（按物理压缩大小判断），超过会拒绝。
- 跨区移动只搬当前选中的会话；子代理会话不会跟着搬，仍留在原工作区。工作区删除的 Host
  事务会收集同一项目目录下的子代理，但当前 UI 不暴露工作区删除。
- 运行中的会话采用「先确认、再停止」：停不下来（`session-bin/session-busy`）就整体拒绝；
  UI 不再禁用菜单/拖拽，Host 也不再返回 `session-bin/session-running`。
- 插件依赖 DSH 0.2.2 的若干服务索引字段与侧栏 DOM 约定；升级到新的 0.2.x 后建议重跑
  `node --test`、三个 e2e 和真机删除/恢复/拖拽。
- Windows CI 已通过（`windows-latest`：138 tests + 三个 e2e）；`crash-injection` 依赖 SIGKILL，
  在 Windows 上自动跳过。仍建议在真实 Windows 桌面手工跑一次删除/恢复/拖拽。
- 恢复旧的工作区条目会新建登记（工作区 id 变化），标题与列表位置会还原。
- 工作区删除走 DSH 自带入口：会话日志保留、会话落「未分组」。**本地文件夹**默认不动；
  配置 `trashWorkspaceFolder: true` 后才由插件送进系统回收站（保护区/跨卷会跳过并记日志）。
  不带 Electron 的独立 `dsh web` 只有 macOS 有 `~/.Trash` 退路。
