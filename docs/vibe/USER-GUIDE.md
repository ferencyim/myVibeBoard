# myVibeBoard 使用指南

myVibeBoard 是 Paseo 的 fork：在 Paseo 之上用 7 个插件加了一块**看板**，让你把想法写成卡片，交给 agent 去做，
做完有**验证证据**给你看，你在手机或电脑上点一下「通过」才算完成。本文面向使用者，按「装起来 → 配好 agent → 日常用法 → 手机 → 已知限制」的顺序写。

相关文档：[BUILD.md](BUILD.md)（构建三端）、[AGENTS-SETUP.md](AGENTS-SETUP.md)（四个 agent 的接入）、
[CONNECTIVITY.md](CONNECTIVITY.md)（配对、选路、自建中继）、[ARCHITECTURE.md](ARCHITECTURE.md)（设计）、
各插件目录下的 `README.md`（细节与 RPC）。本仓库是公开的，文中的主机、域名一律是占位符。

## 1. 概览

| 角色                     | 是什么                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| daemon                   | 跑在你电脑上的 Paseo 后台服务，所有插件的服务端部分在里面运行；数据在 `~/.paseo`（Paseo 自己的）和 `~/.vibe`（看板的 SQLite `vibe.db`，可用 `VIBE_HOME` 改位置）                                        |
| 桌面 / Web / Android App | Paseo 的客户端；插件的界面由 daemon 下发，在 App 里渲染                                                                                                                                                 |
| 7 个插件                 | `vibe-board`（看板与卡片）、`vibe-verify`（验证与证据）、`vibe-master`（总 agent）、`vibe-scheduler`（调度器）、`vibe-context`（项目记忆与压缩）、`vibe-maintain`（自动维护）、`vibe-stats`（用量统计） |
| 卡片                     | 五列：草稿 → 待办 → 进行中 → 待验证 → 已完成。草稿和待办由你控制；进行中由调度器/派发推进；待验证由 agent 做完后自动进入；只有你点「通过」才进已完成                                                    |

## 2. 安装与启动

### 2.1 构建并启动 daemon

在仓库根目录（构建细节与版本要求见 [BUILD.md](BUILD.md)）：

```bash
npm ci
npm run build:server          # 构建 protocol/client/server/cli，约几分钟
```

启动方式二选一：

- 日常使用：沿用 Paseo 的方式启动（桌面 App 自带托管 daemon，或 `node packages/cli/dist/index.js daemon start`）。
- 隔离试用（不碰你正在用的 `~/.paseo`、`~/.vibe`）：`pwsh scripts/vibe/dev-daemon.ps1 -HomeDir <目录> -Port 16767`，
  它会把 `PASEO_HOME`/`VIBE_HOME` 放在 `<目录>` 下，并自动写入 `pluginsEnabled: true`；停止用 `-Stop`。
  Windows 下 `-Plugin` 想一次装多个时，在 PowerShell 里用逗号分隔的数组（`-Plugin plugins/vibe-board,plugins/vibe-verify`），不要通过 `pwsh -File` 传。

### 2.2 启用并安装 7 个插件

目录插件默认不启用，必须先在 `$PASEO_HOME/config.json`（默认 `~/.paseo/config.json`）里写 `"pluginsEnabled": true`
（插件是**不沙箱的受信任代码**，请只装自己仓库里的），然后逐个安装：

```bash
for p in vibe-board vibe-verify vibe-master vibe-scheduler vibe-context vibe-maintain vibe-stats; do
  node packages/cli/dist/index.js plugin install "$(pwd)/plugins/$p"
done
node packages/cli/dist/index.js plugin ls          # 7 个都应是 running / ENABLED yes
```

- 插件自己的依赖需要先装好：`cd plugins/<名字> && npm ci`（每个插件是独立的包，有自己的 `package-lock.json`）。
- 改了插件代码后：`plugin reload <id>`。
- 机器很忙（例如同时在编译）时，插件首次初始化可能超过 120 秒而显示 `failed`，`plugin reload <id>` 即可恢复。
- 只装 `vibe-board` 就能用看板；其余按需加。`vibe-master` 的评估/讨论、`vibe-verify` 的证据、`vibe-scheduler` 的自动放行分别依赖对应插件。

### 2.3 桌面端

按 [BUILD.md](BUILD.md) 第 2 节构建 `packages/desktop/release/win-unpacked/Paseo.exe`。启动后它会拉起自己托管的 daemon；
插件装在这个 daemon 的 home 里（用 `PASEO_HOME` 指向同一个 home 再执行 `plugin install`）。侧栏头部会出现 Vibe Board、会话汇总、Master、
Scheduler、Maintenance、Stats 等入口，命令面板里也有对应命令（如 `Vibe Board: Open`）。

### 2.4 Android 包

构建与安装见 [BUILD.md](BUILD.md) 第 4 节（release APK，用 debug 密钥签名，只含 arm64-v8a 与 x86_64）。安装：

```bash
adb install -r <app-release.apk>
```

注意：我们的包名是 `sh.paseo.debug`（应用名 Paseo Debug），不会覆盖官方 Paseo。首次启动后在 App 里添加主机（配对见
[CONNECTIVITY.md](CONNECTIVITY.md) 第 1、2 节：扫码，或「Add host → Direct connection」填 `<DAEMON_HOST>:端口`；
daemon 监听非回环地址时必须设置密码）。模拟器里访问宿主机的 daemon 用 `10.0.2.2:<端口>`（daemon 绑 `127.0.0.1` 即可）。

连上 daemon 后，App 会收到插件界面；`vibe-board` 的界面还会缓存到手机本地（见第 9 节），之后断网也能打开看板。

## 3. 四个 agent 的配置

Claude Code、Codex、Kimi Code、DeepSeek 的安装、登录与 `agents.providers` 配置见 [AGENTS-SETUP.md](AGENTS-SETUP.md)
（本文不重复；所有登录都由你在终端里自己完成）。要点：

- 卡片用「预设」（preset）选 agent：provider、模型、思考档位、权限模式（`accept-edits` / `auto` / `full`）、环境（项目默认 / 新 worktree 等）、
  附加指令。预设在看板「预设」里管理，卡片和项目都可以指定默认预设。
- 预设旁边显示该 provider 的剩余额度（来自 Paseo 的用量接口）。
- 总 agent（第 7 节）和草稿讨论会话也各用其中一个订阅。

## 4. 看板与卡片流转

打开 `Vibe Board`（侧栏或命令面板）。多个项目用顶部标签切换；一个项目对应一个仓库（`repoPath`）和一个卡片编号前缀（如 `SMK-1`）。

1. **创建项目**：名称、前缀、仓库路径、项目类型（web / backend / android / ios / desktop / other，决定验证用哪类证据采集器）、可选的默认预设与并发上限。
2. **草稿**：写标题、描述、验收标准、优先级、标签、参考图、是否需要证据（`needsEvidence`）、预设。草稿不会被执行。
3. **待办**：你把草稿拖到待办（或「Move to」菜单）表示「可以做了」。手机上也只能在草稿与待办之间移动，并可删除没有会话的草稿。
4. **进行中**：由调度器放行（第 8 节）或你点「Dispatch now」直接派发。派发会为卡片建 worktree、按预设启动 worker agent，并把卡片信息、项目记忆和
   规划交接摘要写进 brief。agent 通过 `vibe-board` 的 MCP/CLI 读写卡片（评论、更新），但**不能移动卡片**。
5. **待验证**：worker 完成后卡片自动进入待验证，验证流水线启动（第 6 节）。
6. **已完成**：你在待验证卡片上点「通过」。随后后台终结流程把卡片分支合并进主分支并移除 worktree（分支保留）；遇到工作区不干净、
   主检出不在目标分支或合并冲突时只在卡片时间线里说明原因，不会强行处理。

卡片详情里有时间线（评论、评估、讨论、状态变化、压缩记录等）、计划版本、会话（agent）列表和验证结果。卡片被「驳回」时回到进行中，
你写的那句话会发给原 worker 继续做。

## 5. 草稿讨论

- 草稿保存后，**总 agent 会在约 30 秒无编辑后评估**：在卡片时间线加一条「评估」评论，写出一版计划（描述、验证清单 `checks`、子任务建议、
  推荐预设）。你自己的字段不会被改写。
- 想讨论就在卡片的讨论页签里发消息：每张卡有一个独立的**规划会话**（planner），它可以让只读侦察员查看仓库，回答后把计划存成新的计划版本。
  讨论的载体就是卡片时间线上的评论，所以手机上（含离线时）写的消息，回到线上后会被规划会话读到并回复。
- 谈妥后点「交接」：规划会话写出 `<仓库>/.vibe/sessions/<卡片号>-plan.md` 并结束，之后你把卡片移到待办；派发时摘要会放进 worker 的 brief。
  如果你没点交接就直接移到待办，规划会话会在后台补做交接。

## 6. 验证证据

卡片进入待验证后，`vibe-verify` 自动运行：

- `needsEvidence` 的卡片：一个独立、**只读**的验证 agent 先给出验证配置（`.vibe/verify.json` 的格式，见 `plugins/vibe-verify/README.md`），
  按项目类型的采集器取证——web（浏览器截图/步骤）、backend（测试命令、HTTP 请求、`backend.perf` 前后对比）、android（模拟器截图/录屏/崩溃信息）、
  ios（经 ssh 连远程 Mac，需 Xcode，目前待硬件验证）、desktop（窗口截图/GIF）——再逐条判断总 agent 写的验证清单。
- 其他卡片：只跑项目的测试和 lint。
- 结论取 **fail > doubt > pass**：`fail` 自动退回进行中，并把失败项发给 worker；`doubt` 和 `pass` 留在待验证等你。
- 在卡片的验证页签里看清单、每条的判断、证据文件（图片、日志、对比），点「通过」或写一句话「驳回」；「重新验证」可再跑一轮。
- 证据保存在 `$VIBE_HOME/verify/<卡片号>/<验证号>/`。手机端的证据只读取缩略图/摘录，不含文件路径。

## 7. 总 agent 与订阅切换

`vibe-master` 维护**一个长期运行的总 agent**（默认 Claude Opus），负责评估草稿、推荐子 agent、卡片完成后整理项目记忆、给 worker 的提问提建议
（但不会替你回答）。

- 状态与切换：侧栏 `Master` 页或命令面板 `Master: Switch to ...`。切换时**先启动新 agent，再收掉旧的**，队列和卡片不变；
  「最高推理」即该 provider 模型目录里最后一档思考选项。
- 额度不足只会提醒（`master.alert` 事件 → 手机推送），**不会自动切换**，由你决定。
- 子 agent 推荐综合额度、优先级、能力表、标签/平台长项和历史战绩（`.vibe/workers/<agent>/MEMORY.md`）；你预先选定的预设永远优先。
- 项目记忆（`.vibe/` 下的状态、决策、教训、索引）按模型上下文窗口的比例限额，超出的最久未用条目自动转入 `*_ARCHIVE.md`；
  `vibe-context` 还会把这些内容注入新建的 agent，并在会话缓存快过期前自动压缩（`/compact` 或交接）。

## 8. 调度器

`vibe-scheduler` 决定待办卡片什么时候开工（侧栏 `Scheduler` 页可看实时状态与全部设置）：

- 顺序：按优先级，再按进入待办的时间。
- 限制：全局并发 `globalLimit`、每个 provider `providerLimits`、每个项目 `concurrencyLimit`、设备池（模拟器等独占租约），取最小者。
- 额度：剩余额度低于 `quotaTightPct` 为紧张（只放行高优先级），低于 `quotaExhaustedPct` 为耗尽（不放行）。
- 内存：占用达到 `memoryThreshold` 时暂停放行并给出最重的会话，回落 5 个点后恢复。
- 端口：为每张放行的卡分配一个开发服务器端口，写进 brief。
- 「Dispatch now」绕过调度器直接派发。

## 9. 自动维护

`vibe-maintain` 按项目 `.vibe/maintenance.yml` 里的规则定期体检，结果变成看板上的卡片。没有该文件时只有内置的 `git-health`
（累计完成 10 张卡或合入 30 个提交触发，生成低优先级草稿，每天最多 1 次）。示例：

```yaml
rules:
  - name: git-health
    enabled: true
    trigger: { kind: workload, cards_done: 10, commits_merged: 30 }
    check: { type: git, stale_days: 14, large_file_mb: 5, outdated: true }
    output: suggest # suggest = 草稿卡；fix = 直接建 worktree 让 agent 修
    priority: low
    daily_cap: 1

  - name: perf-slow
    trigger: { kind: time, cron: "0 4 * * *" } # 本地时间，5 段 cron
    check:
      type: perf-slow
      sources:
        - {
            name: api,
            kind: jsonl,
            path: logs/access.jsonl,
            threshold_ms: 500,
            fields: { site: route, ms: duration_ms, ts: time, method: method },
            unit: ms,
          }
        - { kind: bench-json, path: bench/result.json, threshold_ms: 50 }
      repro: { command: node, args: [bench/run.js, "{site}"], runs: 3 }
    output: fix # 复现成功才建修复卡；否则只出带调查记录的草稿
    agent: codex
    daily_cap: 1
```

- 触发器：`workload`（完成卡数/合入提交数/token）、`time`（cron）、`event`（日志文件新增行匹配）。
- 同一 `dedupe_key` 的未完成维护卡只追加「再次出现」记录，不重复建卡；连续被你驳回 3 次（`pauseAfterRejections`）规则自动暂停，
  在 `Maintenance` 页点「Resume」恢复，也可「Run now」手动跑一次。
- `git-health` 完全不用模型：陈旧分支、已合并未删分支、残留 worktree、未提交/未推送改动、会和主干冲突的分支、大文件、过期依赖。
- `perf-slow` 读 jsonl / bench-json / MySQL 慢日志 / PostgreSQL 日志，按调用点去重，先复现再修，并用 `backend.perf` 做前后对比取证。
- 文件写错时保留内置规则，错误显示在 `Maintenance` 页的 `configErrors`。

## 10. 用量统计

`Stats` 页（桌面与手机）：按 agent / 模型 / 项目 / 日的 token 分布、估算费用、输出速度（中位与 P90）、额度窗口、每张卡的效率
（token、活跃时间、等你回复的时间、压缩次数）、资源使用。数据来自对 Claude Code、Codex、Kimi、DeepSeek 本地日志的增量索引
（Kimi、DeepSeek 的日志格式尚未实机验证）。Claude 5 系与 gpt-6 的模型价格未知，只显示 token 并标「unpriced」，需要在设置里指定 `pricingFile`。

## 11. 手机：离线与推送

- **离线看板**：App 在手机本地保存看板副本。断网/飞行模式下仍可打开看板，编辑卡片（标题、描述、标签、优先级等）、
  在草稿与待办之间移动、写评论；重连后自动同步（字段级后写者胜，删除不会被旧数据复活）。离线时的只读内容（会话、验证结果等）
  显示「as of hh:mm」。第一次冷启动就离线则需要先在线打开过一次（插件界面缓存在手机上）。
- **会话汇总**：侧栏 `会话汇总`，正在等你的会话（审批/提问）置顶，可直接批准或回答；离线时回答排队，重连后核对「问题是否仍然有效」再发出，
  已失效的会提示并丢弃。
- **推送**：卡片进入待验证、worker 等你回答、总 agent 提醒（额度低、维护规则暂停）会推送；正文只含项目名和事件类型，
  不含卡片内容。点击等待审批的推送会直接打开该会话。推送需要自建推送网关与 FCM（见 CONNECTIVITY.md 第 3.3 节）；
  未配置网关时不发推送。

## 12. 远程连接与中继

在外面用手机连家里的 daemon：局域网直连、Tailscale、或自建中继兜底，配对、选路、部署与回滚见 [CONNECTIVITY.md](CONNECTIVITY.md)。
daemon 监听非回环地址必须设密码。

## 13. 已知限制

- Android 只测过 x86_64 模拟器；arm64 真机、iOS 与 iOS 取证（需 Mac + Xcode）尚未验证。
- 推送网关需要 FCM 服务账号；本仓库的包不带 `google-services.json`，所以未自行配置推送时包内没有推送能力。
- 手机离线只覆盖看板数据；总 agent、规划会话、验证流水线都在电脑上，手机离线期间不会推进，重连后继续。
- 手机离线时在草稿与待办之外移动卡片、改会话和验证相关数据都会被拒绝（以服务端数据为准）。
- 插件首次初始化在机器很忙时可能超时（见 2.2），`plugin reload` 即可。
- Windows 上长路径会让 Android 原生部分构建失败，构建细节与规避见 BUILD.md。
- Kimi、DeepSeek 的用量日志解析为尽力而为；维护规则的手机端编辑尚未实现。
- 总 agent 和 worker 都是真实模型会话，会消耗订阅额度；开发测试时请留意额度。
- Windows 上卡片完成后移除 worktree 时，如果该目录仍被残留的 agent 子进程占用，会出现 `Permission denied`：合并已经完成，worktree 目录（或登记）保留，卡片时间线里有说明，等进程退出后手动 `git worktree remove` 即可。
- 调度器在机器内存超过 `memoryThreshold`，或某 provider 额度处于「紧张」且卡片优先级不够时不会放行（Scheduler 页的「等待原因」会写明）；这是预期行为，不是卡住。想立刻开工可用「Dispatch now」，或把卡片优先级调高。
- 新仓库里 `.vibe/` 目录是插件自动生成的项目记忆；卡片完成时的自动合并不会把未跟踪的 `.vibe/` 文件当成「未提交的改动」，建议在项目里把 `.vibe/` 加进 `.gitignore` 或提交它。
- Codex 的 `accept-edits` 预设在 Windows 上经常因沙箱命令环境启动失败而反复请求批准；这些批准都会出现在会话汇总页，手机上逐个批准即可，或为可信任务选 `full` 预设。
