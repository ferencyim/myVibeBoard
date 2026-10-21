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

### 2.x 日常使用安装（与官方 Paseo 并存、开机自启）

构建三端后运行（参数里的域名换成你的中继域名；不用中继就省略这两个参数）：

```powershell
pwsh scripts/vibe/install-local.ps1 -RelayEndpoint <RELAY_DOMAIN>:443 -PushGateway https://<RELAY_DOMAIN>/push
```

- 安装到 `D:\Programs\myVibeBoard`：`app\`（桌面端）、`plugins\`（插件快照）、`data\paseo`（PASEO_HOME）、`data\vibe`（VIBE_HOME）、`data\electron`（桌面端 userData）。不碰 `~/.paseo` 与官方版，端口默认 6868。
- 注册当前用户的登录任务「myVibeBoard Daemon」，开机登录后隐藏启动守护进程；开始菜单「myVibeBoard」打开桌面端，它会接入已在运行的守护进程。
- 推送网关 token 放在 `data\push-gateway.token`（仅当前用户可读），守护进程启动时读入 `PASEO_PUSH_GATEWAY_TOKEN`。
- 首次安装后按脚本提示用 `paseo.ps1 plugin install` 安装各插件；`paseo.ps1` / `start-daemon.ps1` / `stop-daemon.ps1` 都在安装目录。
- 更新：重新构建后先 `stop-daemon.ps1` 并关闭桌面端，再运行安装脚本（只覆盖文件，不删除），最后启动任务。
- 手机：安装 `packages/app/android/app/build/outputs/apk/release/app-release.apk`，在 App 里扫描 `paseo.ps1 daemon pair` 输出的二维码（经中继连接，二维码相当于密码）。

## 3. agent 的配置

Claude Code、Codex、Kimi Code、DeepSeek 只是示例，Paseo 支持的任何 provider（含插件 provider）都可以按需启用；安装、登录、`agents.providers` 配置与如何启用其他 provider 见 [AGENTS-SETUP.md](AGENTS-SETUP.md)
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

卡片详情有这些页签：详情（字段、会话列表）、**群聊**（见第 5 节）、时间线（评论、评估、状态变化、压缩记录等**完整事件记录**）、
方案（计划版本）和验证结果。卡片被「驳回」时回到进行中，你写的那句话会发给原 worker 继续做。

详情页里标题、描述、验收标准是本地草稿：你改过但还没保存的字段，不会被每 3 秒一次的刷新覆盖；保存或点「放弃修改」后才重新跟随服务器。

## 5. 卡片群聊与草稿讨论

每张卡片有一个**群聊**页签，你、总 agent、执行 agent、复核模型、探路兵和系统都在同一条对话里，结论也沉淀在卡片上（不依赖 Paseo 会话）。
群聊**只放关键消息**：工具调用等细节不进来，带 agent 的消息有「查看完整会话」可以跳过去看。「时间线」页签仍是完整事件记录。

**草稿与审查**

- 草稿保存后，**总 agent 会在约 30 秒无编辑后评估**，也可以在群聊顶部点「让总 agent 审查」立即评估。评估除了照旧写「评估」事件和计划版本，
  还会在群聊里发一条结论：可行性、问题和建议。你自己的字段不会被总 agent 直接改写。
- 具体的标题、描述、验收标准修改，总 agent 以**修改建议**卡片给出：列出改动前后对比和理由，你点「采纳」才会改卡片，「不采纳」则只记结果；
  新建议会让旧的待处理建议显示「已被新建议取代」。采纳只能在线操作（手机离线时按钮禁用）。采纳引起的卡片修改**不会**再次触发自动审查。
- 想讨论就在群聊里发消息：每张卡有一个独立的**规划会话**（planner），它可以让只读探路兵查看仓库，回答后把计划存成新的计划版本，也可以再给出修改建议。
- 谈妥后点「转入待办」：规划会话写出 `<仓库>/.vibe/sessions/<卡片号>-plan.md` 并结束；派发时摘要会放进 worker 的 brief。
  如果你没等摘要就直接移到待办，规划会话会在后台补做交接。待办卡片上也可以点「立即执行」。

**你的发言发给谁**（输入框下方会提示）

| 卡片状态       | 你的消息                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| 草稿、待办     | 总 agent 的规划会话                                                                       |
| 进行中、待验证 | 执行 agent 仍在线就发给它（它正在提问时作为回答）；会话已不在、或转发失败，则转给总 agent |
| 已完成         | 只记录，没有人回复                                                                        |

**执行过程写回群聊**（都是关键消息，同一会话同一阶段不会重复写）

- 派发时一条系统消息：派给了哪个预设和 agent，可展开看实际发给它的完整提示词。提示词以卡片**当前**的标题、描述、验收标准为准，
  并带上已采纳的建议和群聊里近期的发言。
- 执行 agent 提问或请求权限时，群聊里出现「提问」；每轮结束时出现该轮最后一条消息的「总结」。
- 复核模型的结论和严重问题；自动退回时有系统行说明原因。验证完成后有一行结果摘要，可直接跳到验证页签。
- 探路兵的结论。

手机端（含离线同步）能看到这些群聊消息；离线时也能发言（提示「离线，联网后发送」，重连同步后由电脑按卡片列路由给总 agent 或执行 agent，只处理一次）；采纳或不采纳建议只能在线操作，离线时这些按钮禁用。手机同步不接受伪造的建议，也改不了建议的状态。

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

`vibe-master` 维护**一个长期运行的总 agent**（默认 Claude Opus），负责评估草稿、推荐子 agent、卡片完成后整理项目记忆和需求文档、给 worker 的提问提建议
（但不会替你回答）。侧栏「总 agent」页看状态、切换订阅、打开历次会话；设置页（Master）改触发和自动化参数；所有提示词在侧栏「Agent 行为」页改（见 7.x）。

- **什么时候被唤醒**（设置「触发」组，每项都可关）：
  - 草稿被新建、修改（标题/描述/验收标准/参考图/标签）、从别的列移回草稿，各有一个自动审查开关；统一等「防抖秒数」（默认 30 秒）无新编辑后才审查，总 agent 自己的回写不会再触发。
  - 看板上的「让总 agent 审查」（`card.review_requested`）和 `master.wake` 一样**立即**审查，不受上述开关、防抖和「内容没变就跳过」限制。
  - 卡片进入完成列：整理项目记忆（开关「卡片完成后整理项目记忆」）；执行会话停下来等你回答（`session.waiting`）：给你写建议（开关「执行会话求助时唤醒」）。
  - 启动补扫：重启后补审最新 N 张（默认 10）没有最新评估的草稿，并补整理 48 小时内完成但没整理过的卡片；可关，数量可调。
- **项目上下文**：每条唤醒消息的项目块带项目简介、全部项目类型和需求文档摘录（默认最多 6000 字符，超长截断并注明，0 为不附带）。
- **需求文档**：开着「维护需求文档」（默认开）时，卡片完成的回复里总 agent 可附带 `requirementsUpdate`（完整新内容 + 一句话摘要），
  插件只提交该文件，提交信息为 `docs(requirements): <摘要> [<卡片编号>]`，**不推送**。只在需求变化或做出新的产品决定时更新，实现细节不算。
  仓库正在合并/变基、文件被 `.gitignore` 忽略、或文档超过摘录上限（总 agent 只看到一部分）时不会写入，卡片上留一条备注并提醒，不会反复重试。
- **提示词**：已全部移到侧栏「Agent 行为」页（设置里的「提示词与规则」组只剩一个入口按钮）。升级前你在旧设置里填过的「规则补充」和三种唤醒模板，
  首次启动时自动迁成**全局覆盖**；之后旧设置项不再被读取，只在那里改。
- **高级：自动化参数**（Master 设置的「高级」组）：向总 agent 提问的超时、规划回合超时、探路超时与轮数、连续回合上限、回复格式不合规时的重试次数、
  采纳建议后免重审的窗口、启动补扫窗口、各类提醒的冷却、项目块列出的卡片数、交接摘要大小与回看天数。默认值与原先写死的值相同。
  Vibe Board 设置的「高级」组同理：派发说明里的备注/群聊条数与交接摘要上限、探路兵缓存/行数/单次任务数、卡死检测轮询间隔。

### 7.x Agent 行为页（所有提示词与自动化入口）

侧栏「Agent 行为」（手机上同样可开）。页面顶部是各插件**自动化设置**的入口按钮；自动维护的规则提示词按规则配置，在「自动维护」页里改，本页只给链接。

- 提示词按角色分组：总 agent、规划会话、执行 agent、探路兵、复核、验证、自动维护、上下文、交接/切换、看门狗。列表来自提示词注册表，
  任何插件注册的提示词都会自动出现在这里。
- 点开一项可看：说明、**何时发送**、**发给谁**、**可用占位符**、**当前生效来源**（默认 / 全局覆盖 / 项目覆盖）、正文编辑框、只读的**固定格式段**。
- 顶部「编辑范围」切换「全局」或某个项目。生效顺序：**项目覆盖 → 全局覆盖 → 默认**。保存时若内容与上一级相同，就等于不覆盖。
- 「恢复默认」清除当前范围的覆盖（项目范围恢复为沿用全局/默认）；「查看默认全文」展示内置原文。
- 正文里用 `{{占位符}}`，发送时一次性替换（替换进来的内容里即使含 `{{…}}` 也不会再被替换）；未知占位符会被替换为空，编辑时会提示。
- **固定格式段**（回复 JSON 的格式要求等）由程序追加在正文之后，不能修改，所以改正文不会让回复解析失败。看板的「回报契约」是单独一项、可编辑：
  它描述看板的流程约定，改文字不会改变看板的实际行为，请保持与实际一致。
- 总 agent 的系统规则可整篇覆盖；规则文本一旦变化，运行中的总 agent 和规划会话会在下一条消息里收到完整的新规则。
- 手机离线时也能查看和改覆盖项（走同步，默认值只由电脑写入）。
- **状态与切换**：侧栏「总 agent」页或命令面板「总 agent：切换到 ...」。切换（以及因权限模式变化而重建）时**先启动新 agent，再结束旧的**，队列和卡片不变；
  「最高推理」即该 provider 模型目录里最后一档思考选项。
- **历次会话与交接**：旧 agent **不会被归档**，「历次会话」列表按时间列出当前和所有历史会话（provider/模型、起止时间、状态、更换原因），点「打开」即可看当时的对话；
  以前被归档的旧会话同样列出，Paseo 能打开已归档的会话（只读，页面上有「取消归档」）。新总 agent 的第一条消息带**交接摘要**，由插件按看板生成
  （最近的审查结论、草稿及其审查状态、近期完成的卡片、近期切换原因，篇幅有上限），不依赖旧 agent 在线。
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
- 避免冲突：总 agent 评估/规划时会在方案里列出卡片「涉及的文件」（glob）。同一项目里，待办卡的文件与进行中/待验证卡重叠时会被延后，
  「等待原因」写明「touches the same files as XXX-12」；没有列文件的卡不受限；可在设置里关掉 `conflictAvoidance`。
- 端口：为每张放行的卡分配一个开发服务器端口，写进 brief。
- 「Dispatch now」绕过调度器直接派发。

## 9. 自动维护

`vibe-maintain` 按规则定期给项目做体检，结果变成看板上的卡片。没有任何配置时只有内置的 `git-health`
（已完成卡片累计 10 张或已合并提交累计 30 个触发，生成低优先级草稿，每天最多 1 次）。规则在「自动维护」页按项目查看、编辑，
也可以写在项目的 `.vibe/maintenance.yml` 里。

**规则从哪来**：每个字段按「内置默认 < 界面配置 < `maintenance.yml`」叠加，后者覆盖前者。`maintenance.yml`
写了的字段在界面里显示为只读，并标注「来自 maintenance.yml」；yml 里同名规则只覆盖它写出的字段，没写的仍用下层的值。
界面配置存在插件设置里（按项目），不改动你的仓库。示例 yml：

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

**在界面里管理规则**（「自动维护」页，规则卡片点「查看与编辑」）：

- 卡片上写着：触发条件的自然语言说明、当前进度（如「已完成卡片 7/10，已合并提交 12/30」）、检查内容、输出方式、今日运行次数、上次运行的时间和结果。
- 可编辑：启用；触发方式（`workload` 阈值、`time` cron、`event` 监视文件与正则）；检查参数（如 `stale_days`、`large_file_mb`）；
  执行 agent（预设名或 `provider/model`，留空表示建议草稿时只做确定性检查、不调用模型）；输出方式（建议草稿 / 直接修复）；
  优先级、每日上限、去重键；提示词。
- 「新建规则」创建自定义规则（检查类型：`git` 或 `perf-slow`）；自定义规则可「删除规则」，只删配置，不影响文件和已生成的卡片。
  内置规则不能删除，只能停用或改参数；字段改回默认值时界面不再保存该项，之后内置默认调整仍会生效。
- 「立即运行」忽略阈值、每日上限和暂停状态手动跑一次；规则被暂停后点「恢复」。

**提示词**：每条规则可以覆盖两段模板——「复核提示词」（建议草稿且配置了执行 agent 时，让只读子 agent 给出整理方案）和
「修复提示词」（输出方式为「直接修复」时发给 worker）。编辑框里直接显示默认模板全文，「恢复默认」一键还原。模板里用 `{{占位符}}`：

| 占位符                                     | 内容                                                              |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `{{project}}` / `{{rule}}`                 | 项目名 / 规则名                                                   |
| `{{trigger_reason}}`                       | 本次为什么触发，如「已完成卡片 10 张，达到阈值 10」或「手动触发」 |
| `{{check_description}}`                    | 这条规则检查什么（自然语言）                                      |
| `{{card_title}}` / `{{summary}}`           | 卡片标题 / 卡片正文（触发原因、发现、影响、建议、验证方法）       |
| `{{findings_json}}` / `{{findings_count}}` | 全部发现的 JSON 明细 / 条数                                       |
| `{{date}}`                                 | 运行日期                                                          |

未知的占位符会原样保留并在保存时提醒。模板后面系统会自动附加不可删除的约束（复核：只读、不改任何文件；修复：只在 worktree 分支提交、
不合并不 push、必须给出报告，以及检查自带的专属要求），所以改坏模板也不会放开这些限制。yml 里用 `prompts: { review: "...", fix: "..." }` 同样可以覆盖。

**生成的草稿卡**：标题和正文都是中文，依次写明「为什么出现这张卡」（哪条规则、因何触发）、「发现了什么」、「影响」、「建议怎么做」、
「怎么验证」，卡片的验收标准列出每类问题的核对方法。

- 触发器：`workload`（完成卡数/合入提交数/token，任一达到即触发，触发后清零）、`time`（cron）、`event`（日志文件新增行匹配）。
- 同一 `dedupe_key` 的未完成维护卡只追加「再次出现」记录，不重复建卡；连续被你驳回 3 次（`pauseAfterRejections`）规则自动暂停，
  在「自动维护」页点「恢复」，也可「立即运行」手动跑一次。
- `git-health` 完全不用模型：陈旧分支、已合并未删分支、残留 worktree、未提交/未推送改动、会和主干冲突的分支、大文件、过期依赖。
- `perf-slow` 读 jsonl / bench-json / MySQL 慢日志 / PostgreSQL 日志，按调用点去重，先复现再修，并用 `backend.perf` 做前后对比取证。
- 配置写错时（yml 或界面）有问题的规则被跳过，其余照常运行，错误显示在「自动维护」页顶部。

## 10. 用量统计

`Stats` 页（桌面与手机）：按 agent / 模型 / 项目 / 日的 token 分布、估算费用、输出速度（中位与 P90）、额度窗口、每张卡的效率
（token、活跃时间、等你回复的时间、压缩次数）、资源使用。数据来自对本地日志的增量索引，内置解析器覆盖 Claude Code、Codex、Kimi、DeepSeek
（Kimi、DeepSeek 的日志格式尚未实机验证；其他 CLI 不会报错但暂不计入，新增解析器的方法见 AGENTS-SETUP.md）。Claude 5 系与 gpt-6 的模型价格未知，只显示 token 并标「unpriced」，需要在设置里指定 `pricingFile`。

## 11. 手机：离线与推送

- **离线看板**：App 在手机本地保存看板副本。断网/飞行模式下仍可打开看板，编辑卡片（标题、描述、标签、优先级等）、
  在草稿与待办之间移动、写评论、在群聊发言、查看群聊；重连后自动同步（字段级后写者胜，删除不会被旧数据复活）。离线时的只读内容（会话、验证结果等）
  显示「as of hh:mm」。第一次冷启动就离线则需要先在线打开过一次（插件界面缓存在手机上）。
- **会话汇总**：侧栏 `会话汇总`，正在等你的会话（审批/提问）置顶，可直接批准或回答；离线时回答排队，重连后核对「问题是否仍然有效」再发出，
  已失效的会提示并丢弃。
- **推送**：卡片进入待验证、worker 等你回答、总 agent 提醒（额度低、维护规则暂停）会推送；正文只含项目名和事件类型，
  不含卡片内容。点击等待审批的推送会直接打开该会话。推送需要自建推送网关（见 CONNECTIVITY.md 第 3.3 节），
  通道二选一或并存：FCM（需要手机有谷歌服务），或 **vivo 官方推送**（vivo 手机在国内用这个）。未配置网关时不发推送。
  - **vivo 推送你需要准备的**：
    1. 在 vivo 开放平台注册开发者，创建一个「应用」并开通「推送」服务，拿到 AppID、AppKey、AppSecret。
    2. 应用的包名必须和你装的 APK 一致（当前调试包是 `sh.paseo.debug`，见 BUILD.md）；控制台要求填的签名指纹
       （以控制台提示的格式为准，通常是证书 MD5/SHA）可用 `keytool -printcert -jarfile app-debug.apk` 或对 keystore 执行
       `keytool -list -v -keystore <keystore> -alias <alias>` 得到。APK 用哪把 keystore 签的，这里就填哪把的指纹。
    3. 从 vivo 推送文档页下载「推送客户端 SDK」的 aar，放到本机 `.secrets/vivo/` 下（仓库根或 `packages/app` 下均可，已被
       `.gitignore` 忽略），再建 `.secrets/vivo/config.json`：`{"appId": "<AppID>", "appKey": "<AppKey>"}`。也可以用环境变量
       `VIVO_PUSH_SDK_AAR`（aar 路径）、`VIVO_APP_ID`、`VIVO_APP_KEY` 代替。三样齐全，下次打包才会带 vivo 推送；缺任何一样，
       包与以前完全一样。**改完要重新 prebuild 并打包**（`expo prebuild` 会把 aar、manifest 配置写进 `android/`）。
    4. 网关服务器的环境变量（写进 `PUSH_ENV_FILE` 那个服务器上的 env 文件，不入库、别贴进聊天）：`VIVO_APP_ID`、
       `VIVO_APP_KEY`、`VIVO_APP_SECRET`，以及 `VIVO_PUSH_MODE`：`1` 是测试推送（只推给测试名单里的设备，自用建议先用它，
       应用未上架时也只能用它），`0` 是正式推送。改完重启网关；`/push/healthz` 会显示各通道是否启用。
    5. 若 `VIVO_PUSH_MODE=1`：在 vivo 控制台的推送测试设备名单里加入你手机的 regId（手机装好带 vivo 推送的 APK 并连上 daemon
       后，regId 完整地保存在 daemon 的 `~/.paseo/push-tokens.json` 里那条 `"channel": "vivo"` 的 `token` 字段；是否必须登记测试名单、在哪里登记，以 vivo 控制台为准）。
  - vivo 手机装了带 vivo 推送的包后优先走 vivo，拿不到 regId 才退回 FCM；点击通知的跳转与 FCM 通知一致。
    连的 daemon 需要是带 `pushChannels` 能力的新版本，旧版本 daemon 不会收到 vivo 注册。

## 12. 远程连接与中继

在外面用手机连家里的 daemon：局域网直连、Tailscale、或自建中继兜底，配对、选路、部署与回滚见 [CONNECTIVITY.md](CONNECTIVITY.md)。
daemon 监听非回环地址必须设密码。

## 13. 已知限制

- Android 只测过 x86_64 模拟器；arm64 真机、iOS 与 iOS 取证（需 Mac + Xcode）尚未验证。
- 推送网关的 FCM 通道需要服务账号，vivo 通道需要 vivo 开放平台凭据；本仓库的包不带 `google-services.json`，也不带 vivo SDK，
  所以未自行配置推送时包内没有推送能力。vivo 通道代码按官方文档写成，本仓库尚未用真实 SDK 编译、也未在 vivo 真机验证。
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
