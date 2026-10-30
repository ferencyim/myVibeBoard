# 资源中枢与总协调 bot

> 2026-10-30 用户拍板：规则中枢 + 总协调 bot；中枢管全机所有会话；总协调 bot 可自行下发临时指令；把「助手」改成总协调。需求见 [PRODUCT-REQUIREMENTS.md](../../PRODUCT-REQUIREMENTS.md) 第十轮第 7 条。

## 1. 为什么分两层

放行一个构建或全量测试，要在几秒内、可预测地给出答案，中枢不可用时还要能退回。这是确定性规则的活。总协调 bot 只做规则做不了的事：调优先级、开维护窗口、下发指令、在 bot 之间传话、解释异常。bot 不在单次放行的路径上，它卡住或掉线不影响放行。

此前「bot 都不自动派发」仍然成立：跨项目 agent 任务和重任务的放行都由中枢规则执行。

## 2. 中枢（vibe-scheduler 演进，界面名「中枢」）

中枢在 daemon 内常驻（vibe-scheduler 插件），用一套资源模型、一条队列管三类东西：

| 类别           | 来源                                  | 现状                                                       |
| -------------- | ------------------------------------- | ---------------------------------------------------------- |
| agent 任务名额 | myVibeBoard 任务与 agent              | 调度器已有（全局/provider/项目并发、文件写锁、设备、端口） |
| shell 重任务   | 任意会话经 win-heavy-guard 提交的命令 | 由 guard 脚本各自判定，中枢看不到                          |
| 共用资源       | 测试 PostgreSQL 实例等                | 无任何保护                                                 |

### 2.1 资源模型

- **机器指标**：沿用 guard 的指标与阈值（`win-heavy-guard.admission.json`：可用内存、commit 比例、CPU 窗口、进程数、句柄、磁盘队列、两次启动最小间隔、硬上限、部署保留名额）。中枢启动时读该文件作为默认值，之后以中枢设置为准，并写回该文件，供中枢不可用时的本地回退使用。采样复用调度器 `server/resources.ts`，补齐 guard 有而它没有的指标（进程数、句柄、磁盘队列）。
- **重任务名额**：agent 任务和 shell 重任务共用机器阈值；重任务另有硬上限（默认 4），优先级 0（部署）始终保留一个名额。
- **共用资源**：命名资源，如 `pg:5435`。每个资源可设共享并发上限（默认 1，即排他）。申请时声明 `shared` 或 `exclusive`。

### 2.2 本机接口（给 guard 与其它进程）

中枢在 `127.0.0.1` 随机端口开 HTTP 服务，启动后把 `{ "port", "token", "pid", "startedAt" }` 写到 `D:\devRepoCaches\validation\locks\win-heavy\hub.json`（与 guard 锁目录同处；token 防本机其它程序误调用，文件仅当前用户可读）。所有请求带 `Authorization: Bearer <token>`。

| 方法 | 路径                     | 作用                                                                                                                                                                                           |
| ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/v1/jobs`               | 申请：`{ owner, project?, command, commandSha256, priority, exclusive, slots, memGb?, resources?: [{ name, mode }], pid }` → `{ jobId, state: "admitted"\|"queued", position?, waitReasons? }` |
| GET  | `/v1/jobs/:id?wait=30`   | 长轮询直到放行或超时，返回同上结构                                                                                                                                                             |
| POST | `/v1/jobs/:id/heartbeat` | 每 15 秒一次；60 秒无心跳且 pid 已死则回收                                                                                                                                                     |
| POST | `/v1/jobs/:id/release`   | 结束：`{ exitCode, durationMs }`                                                                                                                                                               |
| GET  | `/v1/status`             | 机器指标、持有者、排队、等待原因、生效中的暂停与指令                                                                                                                                           |

排队顺序：先看暂停（被暂停类别的申请一律排队并给出原因），再按 `(priority, 用户手动顺序, queuedAt)`。每次放行重新核对机器指标与资源。

### 2.3 guard 客户端（ci-dashboard 仓库）

`win-heavy-guard.py run` 先读 `hub.json`，能连上就走中枢接口；连不上（中枢未启动、超时 2 秒）就退回现有的本地锁逻辑，行为与今天一致。新增 `--resource NAME[:exclusive|:shared]`（可多次）。job object 内存上限仍由客户端本地施加。`status` 子命令优先显示中枢的 `/v1/status`。命令行参数保持兼容，现有调用方无需改动。mac-heavy-guard 不变。

### 2.4 暂停与维护窗口

暂停是一条带范围的规则：`{ scope: 资源名或类别（如 pg:*、build、test、all-heavy）, until, reason, issuedBy }`。命中的申请排队，等待原因显示暂停理由与结束时间。到期自动解除。

## 3. 全局指令

对所有项目生效的规则。存 vibe.db（新表 `hub_directive`：id、text、scope（all / 项目列表 / provider）、kind（temporary / standing）、expiresAt、issuedBy（user / bot）、status（active / pending / revoked / expired）、createdAt）。

- **下发对象**：myVibeBoard 内所有 agent 经 vibe-context 的回合上下文注入（只注入当前生效、与该 agent 范围匹配的指令，变化时注入差异）；myVibeBoard 外的会话通过全局 `~/.claude/CLAUDE.md` 与 `~/.codex/AGENTS.md` 中由中枢维护的标记块（`<!-- vibe-hub:directives:begin -->` … `end`）同步，块外内容绝不改动。
- **谁能下发**：用户随时可在中枢页面下发、撤销。总协调 bot 可自行下发**临时运维指令**（暂停、维护窗口、临时限流等，有效期不超过 24 小时），生效后立即通知用户；**长期规则**由 bot 拟定为 pending，用户确认后才生效。
- 暂停类指令同时写成 §2.4 的暂停规则，由中枢强制执行，不靠 agent 自觉。

## 4. 总协调 bot

把现有独立 bot「助手」改为「总协调」：全局唯一（bot 表新增 `role = 'coordinator'`），侧栏独立 bot 组置顶，默认头衔与角色说明由系统给出，用户可改说明但不能删除或归档该角色（可转移给另一个独立 bot）。可再建通用独立 bot。

工具（MCP，只给总协调 bot 主对话）：

- `vibe_hub_status`：机器指标、队列、持有者、暂停、指令。
- `vibe_hub_queue`：调整排队顺序与优先级（agent 任务与重任务同一队列）。
- `vibe_hub_pause` / `vibe_hub_resume`：按 §2.4 开关暂停与维护窗口。
- `vibe_directive_issue` / `vibe_directive_list` / `vibe_directive_revoke`：按 §3 的权限。
- `vibe_bot_message`：给任一 bot 发消息（见 §5）。
- 已有的跨项目工具保留：`vibe_projects`、`vibe_project_tasks`、`vibe_create_task` 等。

中枢事件主动通知总协调 bot（作为系统来源消息，忙时排队到回合结束）：重任务排队超过 15 分钟、资源持续紧张、暂停或指令到期、任务失败或卡住超过阈值。总协调 bot 只在需要时打扰用户。

## 5. bot 之间的消息与任务感知

- **消息**：`vibe_bot_message({ to: botId | "coordinator" | { projectId }, text })`，`{ projectId }` 发给该项目默认 bot。投递为目标 bot 主对话里一条标明发送方的系统来源消息，目标忙时等回合结束再投递；记录在 vibe.db（新表 `bot_message`）。所有 bot 都有这个工具；项目 bot 默认只能发给总协调和同项目 bot，经总协调转达其它项目，避免 bot 之间无约束地互相触发。
- **防循环**：同一对 bot 之间 10 分钟内超过 6 条消息即暂停投递并通知总协调。
- **任务感知**：新增只读工具 `vibe_tasks_overview`，所有 bot 可用，返回全部项目任务的精简状态（项目、任务名、阶段、档位、是否在等用户、最近活动）。项目 bot 修改仍只限本项目。任务进入「需要你」或失败时，通知该项目默认 bot；跨项目影响（例如占用共用资源）由总协调转达。

## 6. 界面

「调度器」页改名「中枢」，分区：机器（实时指标与阈值）、队列（agent 任务与重任务统一列表：来源会话/项目、命令摘要、优先级、状态、等待原因，可拖排、可暂停）、共用资源（资源列表、当前持有者、并发上限）、暂停与窗口、全局指令（生效 / 待确认 / 历史，下发与撤销）、运行记录。总协调 bot 在侧栏独立 bot 组置顶；页面轨用量圆环不变。

## 7. 分包

| 包     | 内容                                                                                 | 依赖                                         |
| ------ | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| WP-170 | 中枢核心：资源模型、统一队列、§2.2 本机接口、`hub.json`、与 guard 配置互通、暂停规则 | —                                            |
| WP-171 | guard 客户端（ci-dashboard 仓库）：§2.3                                              | 按 §2.2 约定并行开发                         |
| WP-172 | 全局指令：表、注入、全局文件标记块同步、权限                                         | 按 §3 并行                                   |
| WP-173 | 总协调 bot 与消息：助手转为总协调、§4 工具、§5 消息与任务感知、事件通知              | 中枢工具调用 WP-170 的服务内接口，按约定并行 |
| WP-174 | 「中枢」页面：§6                                                                     | 依赖 WP-170、172 的 RPC，约定好后并行        |
