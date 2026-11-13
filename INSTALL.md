# 安装与验收清单（M4-3）

> 这一步会写 `~/.dsh` 并重启 DSH。重启会结束当前正在跑的所有会话——请在**没有正在进行的对话**时做，
> 或者先确认这些会话可以中断。

## 0. 前置条件

- DSH **0.2.2-rc.1**（desktop profile），Node ≥ 22，pnpm 可用。
- 包在 `dsh-workspace-bin/` 下，`package.json` 的 `dsh.engines.dsh` 写着兼容范围。
- 如果装了 `dsh-plugin-session-purge`，先决定留哪个：两者都有会话回收站，功能重叠，建议二选一。

## 1. 安装

```bash
cd ~/.dsh/profiles/desktop

# 1. 备份 profile 清单，出问题能原样退回去
cp package.json package.json.bak-before-workspace-bin

# 2. 把本地目录链进依赖（改代码不用重装）
pnpm add link:/Users/chenming/Documents/dsh-workspace-bin

# 3. 在 package.json 的 dsh.profile.bundles 数组里加一行：
#    "dsh-workspace-bin"
#    （位置随意，建议放在 dsh-plugin-session-purge 附近）

# 4. 预检（只读，不写盘）
cd /Users/chenming/Documents/dsh-workspace-bin
node scripts/check-profile.mjs
```

`check-profile.mjs` 会打印：profile 清单里有没有这个包、`node_modules` 的链指到哪、
engines 是否匹配。全部 OK 再重启 DSH。

## 2. 重启后的验收（按顺序做，每步都可回退）

| # | 动作 | 期望 |
|---|---|---|
| 1 | 打开侧栏 | 页脚出现「回收站」（初始没有计数） |
| 2 | 打开任意会话的「…」菜单 | 菜单里有「回收会话」；工作区菜单里**没有**插件加的删除项 |
| 3 | 点「回收会话」 | 确认框显示路径、大小、运行中状态、搬运方式；取消不发请求 |
| 4 | 拿一个**废弃会话**确认 | 确认后会话行消失；页脚计数 +1；回收站面板里出现该条目 |
| 5 | 面板里点「恢复」 | 会话行回到原分组、能打开继续聊；条目消失 |
| 6 | 再删一次，这次点「永久删除」 | 二次确认后条目消失；`<DSH_HOME>/workspace-bin` 下对应目录被删 |
| 7 | 再删一次，然后**重启 DSH** | 回收站条目还在（持久化），不会被启动清理 |
| 8 | 把一条会话从工作区 A 拖到 B | 目标分组高亮；松手后会话出现在 B；A 里消失 |
| 9 | 拖到自己所在分组 | 完全不接管（官方的组内排序照常工作） |
| 10 | 删除一个正在回答的会话 | 先停回合（最多 3 秒），停不下就拒绝并报错 |
| 11 | 先在 `cordis.patch.yml` 给 `workspace-bin` 配 `trashWorkspaceFolder: true`，再用临时工作区点官方「删除工作区」 | 文件夹进系统回收站（废纸篓里能看到），工作区从列表消失，会话进「未分组」；不配置时目录保持不动 |
| 12 | 用插件删一条会话 | 只动会话目录；它所属的工作区文件夹**不动** |

数据侧可以随时对照：

```bash
ls ~/.dsh/workspace-bin/                 # 每个条目一个目录，manifest.json 是唯一清单
cat ~/.dsh/workspace-bin/*/manifest.json # state: planned/done/failed
ls ~/.dsh/sessions/_workspace-bin-staging/  # 正常应为空（或只有待恢复的 op）
```

## 3. 出问题时的回滚

```bash
cd ~/.dsh/profiles/desktop
# 1. 从 dsh.profile.bundles 里删掉 "dsh-workspace-bin"
# 2. 还原清单（二选一：手工删依赖，或用备份）
cp package.json.bak-before-workspace-bin package.json
pnpm install
# 3. 重启 DSH
```

- 回滚**不会**删回收站里的数据：`~/.dsh/workspace-bin` 还在。要清掉它需要手工 `rm -rf`，
  那就是真删字节了，先确认没有要恢复的东西。
- 如果重启后页面白屏：先把插件行注释掉重启，确认是插件问题；控制台里的报错会指出是
  `client.js` 加载失败还是 slot 注册失败。

## 4. 隔离实例自测（不碰 desktop profile）

不想动真实 profile 时，可以起一个独立实例：

```bash
cd /Users/chenming/Documents/dsh-workspace-bin

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

- Desktop profile 的 UI 验收（本清单 1~10 步）仍需人工执行；隔离实例只验证了 Host 路由与事务。
- 跨区移动一次最多读 256MB 日志，超过会拒绝。
- 逐会话模式只带走工作区成员与**同一项目目录**下的隐藏子代理；cwd 在别处的子代理会留下并在
  确认框里点名。
- Windows 的写锁是路径派生的命名信号量（没有 `session.lock`），释放探针按 POSIX 写的，未实测。
- 恢复旧的工作区条目会新建登记（工作区 id 变化），标题与列表位置会还原。
- 工作区删除走 DSH 自带入口：会话日志保留、会话落「未分组」；**本地文件夹**由插件送进系统回收站
  （保护区/跨卷会跳过并记日志）。不带 Electron 的独立 `dsh web` 只有 macOS 有 `~/.Trash` 退路。
