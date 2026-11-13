# 发布清单 · npm

> 目标渠道：npm 公开包 `dsh-session-bin`（registry.npmjs.org）。
> 本文件是发布前的检查与操作单；**最后一步 `npm publish` 是对外不可逆动作，由你执行**。
> 记录时间：2026-11-13，版本 0.1.0（首个 npm 版本，也是改名后的首个版本）。

## 1. 当前结论

本地准备已完成：元数据、展示资源、文档、产物与冒烟都过了。剩下 2 件只有你能做的事：
**发布时输入 2FA OTP**、**显式指定 npmjs registry**（本机默认是镜像）。GitHub 仓库已配置为
`https://github.com/chenhaha-ivi/dsh-session-bin`。

| 项 | 状态 |
|---|---|
| 包名 `dsh-session-bin` | ✅ npmjs 未被占用（`npm view` 返回 404）。市场里另有 `@takboo/dsh-session-bin`，同名不同作用域，互不影响 |
| `node --test` | ✅ 136 passed / 0 failed |
| 三个 e2e + 崩溃注入 | ✅ `m1-e2e`、`m3-session-e2e`、`m3-move-e2e`、`crash-injection` 全 OK |
| 打包产物 | ✅ 28 个文件，约 78 kB（精确大小与校验值见仓库根目录 `CHECKSUMS`，不随包发布） |
| `npm publish --dry-run` | ✅ 通过，目标 npmjs，无告警 |
| 元数据 | ✅ `author: webchenming`；`repository` / `homepage` / `bugs` 已指向 `https://github.com/chenhaha-ivi/dsh-session-bin` |
| npm 登录 | ✅ `npm whoami` = `webchenming` |
| 默认 registry | ❌ 指向 `registry.npmmirror.com`，发布必须显式覆盖 |
| 2FA | ⚠️ `auth-and-writes`，`npm publish` 会要求一次性验证码（OTP 约 30 秒有效，建议在终端交互执行） |
| GitHub 仓库 | ✅ `origin` = `https://github.com/chenhaha-ivi/dsh-session-bin.git`；首次推送后 CI 生效 |

## 2. 发布前你需要做的事

1. **2FA**：账号为 `auth-and-writes`。在终端执行第 6 节的命令，按提示输入 OTP。
2. **registry**：命令里已显式写 `--registry=https://registry.npmjs.org`，不要省。
3. **仓库**：已写 `repository` / `homepage` / `bugs` 并指向 `https://github.com/chenhaha-ivi/dsh-session-bin`；
   以后迁地址时改 `package.json` 后重打一次包即可。
4. **缓存（通常不用管）**：本机 `~/.npm` 权限正常；若发布报缓存权限错误，命令里已带 `--cache ./.npm-cache`。

## 3. 本轮已完成的准备

- `package.json`：移除 `private`；补 `author`、`keywords`（deepseek-harness / drag-and-drop）、`prepublishOnly: npm test`；
  新增 `./locale/*.json` 导出与 `locale/*.json` 的 `files`。
- **`engines.dsh` 从 `dsh.engines` 移到顶层 `engines.dsh`**：查过 `dsh-app-boot` 源码，安装/启动校验读的是
  顶层 `manifest.engines.dsh`；原来嵌套的那份不会被检查。`scripts/check-profile.mjs` 与
  `test/manifest.test.mjs` 已同步。
- 展示资源：`locale/zh.json`、`locale/en.json`（`meta.title` / `meta.description` / `meta.detail`）；
  `docs/DETAIL.md`、`docs/DETAIL.zh.md`（各一张图）；`docs/preview.svg`（640×300，纯图形、无文字/脚本/外链）。
  预览图用 headless Chrome 渲染检查过，明暗两种背景下都在自带深色面板内可读。
- 文档：README 增加 npm 安装方式并去掉「仍是 private、没发 npm」的说明；INSTALL 拆成 npm / 本地链接两种安装；
  CHANGELOG 记发布相关变化；DEVELOPMENT 的发布检查单改成当前流程。
- `scripts/check-profile.mjs`：兼容 npm 安装（`installedCopy`），不再只认软链。
- `test/manifest.test.mjs`：断言去 `private`、`engines.dsh` 在顶层、locale 导出与详情页资源存在。
- 提交（改名收尾 + 发布准备）与 annotated tag `v0.1.0` 见第 9 节。
- 评审后修复：恢复重试补归属、系统回收站保护区祖先、目标目录校验、未登记数据保护、项目目录复核、
  `Config` schema、定向索引更新、客户端部分完成提示、错误码本地化；新增 `windows-latest` CI。

## 4. 产物

```sh
npm pack --pack-destination dist --cache ./.npm-cache
```

| 项 | 值 |
|---|---|
| 文件 | `dist/dsh-session-bin-0.1.0.tgz` |
| 文件数 | 28（含 RELEASE.md 自身） |
| 大小 / 校验 | 见仓库根目录 `CHECKSUMS`（`shasum -a 256 -c CHECKSUMS` 可直接校验，sha1 与字节数在同文件注释里）；该文件不随包发布，避免「文档记录自身哈希」的循环 |
| 内容 | `host.js`、`client.js`、`src/host/*`、`cordis.patch.yml`、`locale/{zh,en}.json`、`icon.svg`、`docs/*`、README / INSTALL / RELEASE / CHANGELOG / LICENSE、两个维护脚本 |

不含：`test/`、`scripts/` 下的 e2e/崩溃脚本、`PLAN.md`、`TASKS.md`、`dist/`、`node_modules`。

## 5. 冒烟验证（已做）

把 tarball 解到临时目录（本机用 `.test-tmp/smoke-final/`）后直接导入并核对资源：

```sh
node --input-type=module -e "const m=await import('./host.js'); console.log(Object.keys(m).sort())"
# → [ 'Config', 'apply', 'inject', 'name' ]；name = dsh-session-bin

node -e "const p=require('./package.json'); console.log(p.private, p.engines.dsh, p.author)"
# → undefined  >=0.2.2-rc.1 <0.3.0  webchenming
```

`locale/zh.json`、`locale/en.json`、`docs/DETAIL*.md`、`docs/preview.svg`、`icon.svg` 都在包内且能解析。
`npm publish --dry-run` 会先跑 `prepublishOnly`（即 `npm test`），136 个用例全绿后才会继续。

## 6. 发布

```sh
cd ~/Documents/dsh-session-bin
npm publish --registry=https://registry.npmjs.org --cache ./.npm-cache
```

- 不加 `--dry-run` 就是真发布；会先跑 `npm test`，失败即中止。
- 2FA 模式为 `auth-and-writes`，交互执行时会提示 OTP；脚本方式需 `--otp`（一次性，时效很短）。
- 发布后 24 小时内版本号不可复用；72 小时内可 `npm unpublish`（有条件）。
- 安装侧依据 DSH 自带《打包与安装插件》：`dsh plugin add <包名>` 安装的就是预构建代码，
  `engines.dsh` 会在安装与启动时校验。

## 7. 发布后验证

1. `npm view dsh-session-bin version --registry=https://registry.npmjs.org` → `0.1.0`。
2. 在测试 profile 安装（别拿当前 desktop profile 试卸载）：
   ```sh
   dsh plugin --profile <测试 profile> add dsh-session-bin
   ```
3. 新会话里：侧栏页脚出现「回收站」，会话「…」菜单出现「回收会话」；删一条会话 → 面板恢复 → 永久删除。
4. 打开 Plugins 页目检：中文标题「会话回收站」、英文「Session recycle bin」、描述、图标、详情页预览图，
   以及 `docs/DETAIL.zh.md` / `docs/DETAIL.md` 是否按语言取到。
5. 需要市场收录时，向 `awesome-dsh-plugin` 提 PR（目录源是 `https://awesome-dsh-plugin.com/plugins.json`）；
   这一步需要 GitHub 仓库，建议先推送源码。

## 8. 回滚

- 72 小时内：`npm unpublish dsh-session-bin@0.1.0 --registry=https://registry.npmjs.org`。
- 超过 72 小时：`npm deprecate dsh-session-bin@0.1.0 "reason"`，再发修复版。
- 安装侧回滚：`dsh plugin --profile <name> remove dsh-session-bin` 后重启。
  回收站数据在 `<DSH_HOME>/session-bin/`，卸载不会自动删；要清掉得手工 `rm -rf`（真删字节）。

## 9. 源码提交与标签

发布准备、改名收尾与评审后修复已分成三个提交，`v0.1.0` tagged 到修复后的提交：

```sh
git tag -n                    # v0.1.0  dsh-session-bin 0.1.0
git log --oneline -3
```

`origin` 已配置为 `https://github.com/chenhaha-ivi/dsh-session-bin.git`，首次推送：

```sh
git push -u origin main --tags
```

推送后 GitHub Actions 的 `windows` 工作流会跑单测与三个 e2e。

## 10. 未验证边界

- 真实 `npm publish` 未执行（要 OTP，且是本清单约定的最后一步）。
- npm 安装链路（`dsh plugin add dsh-session-bin`）要等真正发布后才能验证。
- DSH Plugins 页里的实际排版（标题/描述/详情图/明暗主题）未在真机目检；只验证了资源文件、
  预览图的独立渲染与元数据解析。
- GitHub 仓库已配置，但 `origin` 首次推送与 Windows CI 尚未验证。
- Windows CI 工作流（`.github/workflows/windows.yml`）已加入，但尚未在 GitHub 上实际跑过；
  Windows 仍按「未真机验证」看待。
