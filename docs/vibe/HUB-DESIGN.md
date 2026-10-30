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
- **重任务名额**：agent 任务和 shell 重任务共用机器阈值（agent 任务只在接管开关打开后才受机器阈值约束；开关关闭时只受 `agents` / `project:名称` 暂停约束）；重任务另有硬上限（默认 4），优先级 0（部署）始终保留一个名额。
  - **名额语义**：每个 job 占 1 个名额（可选字段 `units` 占多个，默认 1，guard 不传；独占 job 视为占整机）。机器总容量 = min(中枢 `hardLimit`, guard 的名额数)，guard 的名额数读锁目录 `slots.txt`（1–8，缺失用 `hardLimit`），且只有锁目录存在 `admission-state.json`（动态模式）才用该值，否则与 guard 一样取 min(2, 值)。普通任务最多占 容量−1，优先级 0 可用最后一个（与 guard 的 `admission_reasons` 一致）。guard 的 `--slots`/`slots.txt` 是**机器总名额**，绝不能当作某个 job 的占用发给中枢。
  - **防死锁保险**：中枢与本地都没有存活持有者时，队首（未被暂停、无共用资源冲突）直接放行，忽略名额、间隔与机器指标；若本来会被拦（如内存不足）则在锁目录 `logs/<日期>.jsonl` 写 `hub_empty_machine_bypass` 事件（含被忽略的原因）。
- **共用资源**：命名资源，如 `pg:5435`。每个资源可设共享并发上限（默认 1，即排他）。申请时声明 `shared` 或 `exclusive`。

### 2.2 本机接口（给 guard 与其它进程）

中枢在 `127.0.0.1` 随机端口开 HTTP 服务，启动后把 `{ "port", "token", "pid", "startedAt" }` 写到 `D:\devRepoCaches\validation\locks\win-heavy\hub.json`（与 guard 锁目录同处；token 防本机其它程序误调用，文件仅当前用户可读）。所有请求带 `Authorization: Bearer <token>`。

| 方法 | 路径                     | 作用                                                                                                                                                                                            |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/v1/jobs`               | 申请：`{ owner, project?, command, commandSha256, priority, exclusive, units?, memGb?, resources?: [{ name, mode }], pid }` → `{ jobId, state: "admitted"\|"queued", position?, waitReasons? }` |
| GET  | `/v1/jobs/:id?wait=30`   | 长轮询直到放行或超时，返回同上结构                                                                                                                                                              |
| POST | `/v1/jobs/:id/heartbeat` | 每 15 秒一次；60 秒无心跳且 pid 已死则回收                                                                                                                                                      |
| POST | `/v1/jobs/:id/release`   | 结束：`{ exitCode, durationMs }`                                                                                                                                                                |
| GET  | `/v1/ping`               | 只校验 token，立即返回 `{ ok: true, pid, startedAt }`；guard 用它探测中枢是否可用                                                                                                               |
| GET  | `/v1/status`             | 机器指标（读缓存，过旧时带 `stale`）、持有者、排队、等待原因、生效中的暂停与指令                                                                                                                |

**机器指标后台采样**：中枢每 5 秒在后台采样一次（CIM 查询最长 8 秒，单飞不重叠），`/v1/status`、`/v1/jobs` 准入、`hub.status` RPC 一律读最近缓存，请求路径上从不等待采样；缓存超过 30 秒或尚无采样时在 `machine.metrics.stale` 标注，仍照常服务（缺失指标视为未知，不阻塞）。

**与本地锁互相可见（混用安全）**：中枢的锁目录就是 `hub.json` 所在目录。中枢放行一个 job 时，在锁目录写与本地模式相同的持有者目录 `slot-<n>-<申请方pid>-<jobId去掉连字符>`，`owner.txt` 字段与 guard 一致并带 `"via": "hub"`、`hub_job_id`（独占 job 写一个目录，其余按 units 写多个）；release 或回收时删除。中枢准入时读取锁目录里不属于自己的 `slot-*` 目录，进程存活的计入名额，`exclusive` 不为 false 的（含无法读取元数据的）按独占持有者处理；进程已死的忽略，其中 `via=hub` 的残留目录顺手清掉。这样 guard 退回本地锁时，本地模式也能数到中枢放行的任务。已知余量：中枢读写目录不持有 guard 的 `admission.lock`，两边恰好同一毫秒级窗口同时放行时仍可能多放一个，下一轮即互相可见。

排队顺序：先看暂停（被暂停类别的申请一律排队并给出原因），再按 `(priority, 用户手动顺序, queuedAt)`。每次放行重新核对机器指标与资源。

**接管开关（默认关闭）**：「中枢」页面机器区顶部的「接管全机重任务」，状态存 vibe.db（`hub.takeover`）。关闭时中枢不开 HTTP、不写 `hub.json`（已写的会删除），所有 guard 走本地锁；打开时才写。切换前页面会二次确认。应急回退：锁目录下放一个 `hub.disabled` 文件，guard 立即忽略中枢（不论开关），删除即恢复。guard 另外随申请上报 `category`（build/test/deploy/db/other，本机按完整命令推断，不上传参数），中枢用它匹配暂停范围 build/test/deploy/db，缺失时按命令名兜底。暂停范围 `agents` 与 `project:名称` 同样挡住新的 agent 任务（`all-heavy` 只管 shell 重任务），agent 任务准入还会检查中枢的机器阈值。

### 2.3 guard 客户端（ci-dashboard 仓库）

`win-heavy-guard.py run` 先读 `hub.json`，用 `GET /v1/ping`（超时 2 秒）探测，能通就走中枢接口；`hub.json` 不存在或存在 `hub.disabled` 时直接走本地锁。`hub.json` 存在但探测或放行前的申请失败时**不再静默**：stderr 输出 `WIN_HEAVY_HUB_FALLBACK reason=…`，审计日志写 `hub_unreachable` 事件，再退回现有的本地锁逻辑（本地模式能数到中枢放行的任务，见 §2.2）。新增 `--resource NAME[:exclusive|:shared]`（可多次）。job object 内存上限仍由客户端本地施加。`status` 子命令优先显示中枢的 `/v1/status`。命令行参数保持兼容，现有调用方无需改动。mac-heavy-guard 不变。

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
