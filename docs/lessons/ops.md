# 日用环境与本机运维经验

工程类经验（测试桩、插件接口、性能诊断）在 `docs/vibe/ENGINEERING-LESSONS.md`，这里只放装机、中枢、依赖事故和 Codex 启动。

## 装机与实测（2026-10-29）

第九轮 WP-132 至 135 测试全绿，真实应用里却是：任务只显示 #1，插件设置页藏在“…”菜单里，项目 agent 打不开；还有一次安装静默中止（`check-plugins` 拒绝了 manifest 版本范围，当时只 grep 了输出，忽略了退出码 1）。所以：

- 每次装机核对安装脚本退出码，确认改动文件确实落到 `D:\Programs\myVibeBoard`。
- 重新启动已装桌面版：`D:\Programs\myVibeBoard\app\Paseo.exe --remote-debugging-port=9340`，环境变量 `PASEO_HOME`、`VIBE_HOME`、`PASEO_ELECTRON_USER_DATA_DIR` 同 `launch-desktop.ps1`。（2026-10-30 记录：9339 曾被死进程占用，改用 9340。）
- 用仓库 `node_modules` 里的 Playwright `chromium.connectOverCDP` 截图、读文本、点击。`PrintWindow`、`CopyFromScreen` 对这个 Electron 窗口无效。
- 逐条走用户的每条需求并列通过或失败；没有后端状态时界面也要完整（占位 tab、可见的设置入口）。

## 带迁移的插件更新要整体重启（2026-10-26）

把 WP-130 插件复制进安装目录后逐个 `paseo.ps1 plugin reload`，vibe-board、vibe-context、vibe-stats、vibe-verify 卡约 11 分钟后报 “did not initialize”；迁移本身（18→20）在副本上只要约 0.2 秒。整体重启（`stop-daemon.ps1`，再 `Start-ScheduledTask 'myVibeBoard Daemon'`）约 4 分钟 8 个插件全部起来，库已迁移。怀疑是交错 reload 时新旧插件进程同时持有 `vibe.db`，未证实。

做法：先用 `VACUUM INTO` 备份（robocopy 复制活库可能退出码 9），确认没有 agent 在跑，再整体重启。

## 资源中枢接管（2026-10-30）

两次打开“接管全机重任务”都出问题，第二次让别的会话的数据库任务排队约 10 分钟：

1. 日用守护进程设了 `VIBE_HOME`，被中枢当成开发守护进程，`hub.json` 写进私有目录（已在 `install-local.ps1` 设 `VIBE_HUB_DIR`、`VIBE_HUB_ADMISSION_FILE`）。
2. `/v1/status` 在请求路径里采样指标超过 2 秒，guard 静默回退本地（已改 `/v1/ping` 加后台采样加 FALLBACK 提示）。
3. guard 的 `slots` 是机器总名额（`slots.txt`），却被当成单个任务的占用发给中枢，空闲时也 `slots_full`（WP-180 修）。

根因是测试只用了 slots=1 的干净临时目录，没复刻真实锁目录（`slots.txt`、`admission-state.json`）。再开接管前：

- 回归测试用真实锁目录形态；先通知其他会话，避开它们的发布窗口。
- 开启后立刻用两个轻量命令验证 `admission_path=hub` 且能放行。
- 异常时先放 `hub.disabled`，再停守护进程，并把 `vibe_meta` 的 `hub.takeover` 设为 false。设计见 `docs/vibe/HUB-DESIGN.md`。

同日曾把 `ci-dashboard` 里 `win-heavy-guard.admission.json` 的未提交改动（硬上限 5、最低可用 5GB、CPU 90%）误判为中枢写坏并想恢复，实际是用户自己改的。用户要求阈值少留裕度，由总协调 bot 判断平衡值（WP-181）。

## 依赖事故（2026-10-29）

1. oxlint 1.61（开 jsPlugins）在本机每线程提交约 6GB 内存，默认 32 线程约 200GB，提交钩子里的 lint 打满整机提交内存，连带别的会话的测试 PostgreSQL 崩溃。1.65 起已修（8 线程峰值 0.8GB），仓库现钉 1.65.0。旧 worktree 可能仍是 1.61；版本未确认安全时，用带内存上限的看门狗先跑单文件。整机视角见全局 `machine.md`。
2. 为升级 oxlint 在 worktree（各 `node_modules` 是指向主目录的 junction）里跑 `npm install`：npm 删掉根 junction，又顺着子包 junction 往主目录 `packages/*/node_modules` 写入，失败回滚时把主目录 `packages/app/node_modules` 里约 139 个包清空。

## Codex 在本机的启动（2026-10-29）

通用命令和容量退避见全局 `delegation-lanes.md`。这里是当时在本项目踩到的限制，恢复使用 Codex 前先核是否还成立：

- `~/.codex/config.toml` 为 `[windows] sandbox = "unelevated"`（为避开 elevated 刷新 ACL 与 `node_repl.exe` 冲突）。不提权沙箱运行不了商店版 pwsh（`CreateProcessAsUserW failed: 5`），已装 MSI 版 PowerShell 7；后台启动前把 PATH 从注册表重载，否则还是旧 PATH。
- 后台运行时 `codex exec` 会等 stdin，不关就卡在 “Reading additional input from stdin”。PowerShell 用 `$brief | codex exec ... -`（不支持 `< file`）。
- 沙箱内 node 启动子进程（esbuild→vitest、oxfmt）报 `spawn EPERM`，`--add-dir` 也无效。Codex 只能写代码和跑 typecheck、lint；测试和格式化由主代理在沙箱外补跑，再把失败细节交回。
- 多路并行时续跑用 `codex exec resume <session id>`，不要用 `--last`。Codex 有时只做一部分就写报告收工，简报要写“全部做完再停”。
- 日志里 `hook: PreToolUse Failed` 是 Paseo 终端活动钩子，非 Paseo 终端下无影响。
- `packages/app/src/plugins/evaluate.test.ts` 当时在 main 上也报 `Cannot find module './ImportMetaRegistry'`，属环境问题（Node 24，见工程经验第 27 条）。
