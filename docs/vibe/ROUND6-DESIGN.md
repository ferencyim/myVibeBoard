# 第六轮设计：原生多 tab，tab 之间互相交流

> 2026-10-24。需求见 [PRODUCT-REQUIREMENTS.md](../../PRODUCT-REQUIREMENTS.md) 第六轮。取代 [ROUND5-DESIGN.md](ROUND5-DESIGN.md) 第三版中的群聊容器（WP-111）与会话内任务面板（WP-115 的 panel 部分）；第五轮的数据合同（WP-110）、调度/验证/维护/统计接轨（WP-112）、手机首消息 outbox（WP-113）、旧看板删除（WP-114）继续有效。

## 1. 用户看到的样子

- 一个任务 = 一个 workspace（独立 worktree）。顶部 tab 就是流程，每个 tab 是一个普通的 Paseo agent 会话，标题为 `#编号 角色 · 模型`，例如 `#1 主会话 · Sol`、`#2 探路 · deepseek-flash`、`#3 执行 · Sol`、`#4 复核 · Opus`、`#5 验证 · deepseek-flash`。编号在任务内从 1 递增、固定不变，关掉的 tab 编号不复用。
- 第七轮起，`#1 主会话` 由首条消息创建后，插件立即按项目/全局默认预建 `#2 探路`、`#3 执行`、`#4 复核`、`#5 验证`（探路、复核默认不启用时不建）。除 #1 外都不带初始 prompt，保持空闲、不消耗 token。旧任务只在活动阶段、由回合事件或用户命令（如 `/执行`）补建缺少的角色 tab；暂停、完成、失败或归档中的任务不补建，面板和 `/状态` 只读、不补建。
- `#1 主会话` 负责整理需求和出方案。用户在 #1 里确认方案（`/执行`），插件把方案发给已存在的执行 tab；执行完照常进入复核（选了才进）、验证，并复用已存在的复核/验证 tab；验证通过后用户 `/通过`（或单独发「通过」），插件做 Git 收尾。用户也可以直接打开任一 tab 对话：直接和执行 tab 说话本身就是执行授权，插件在用户发消息时补做资源准入。
- **换模型 = 开新 tab**：用户点原生「+」新建 tab、选模型，说「继续 #3 的工作」。插件给这个新 tab 编号、注入同任务 tab 清单与交流说明，新 agent 读取 #3 的记录接着做。
- 子代理仍是执行 tab 的原生子代理（Subagents track），不占顶部 tab。

## 2. tab 之间的交流（核心）

复用 Paseo 现有 agent MCP 工具，不做消息路由、不做群聊容器：

| 需要                                    | 用什么                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| 看同任务有哪些 tab、#编号对应哪个 agent | 插件 MCP 工具 `vibe_tabs`（返回 `#n → agentId、角色、模型、状态`）                            |
| 读另一个 tab 的记录                     | Paseo `get_agent_activity`（按 agentId）                                                      |
| 给另一个 tab 发消息 / 交代任务          | Paseo `send_agent_prompt`                                                                     |
| 等另一个 tab 做完                       | `send_agent_prompt` 默认完成通知，或 `get_agent_activity` 查询（本 fork 无 `wait_for_agent`） |
| 开新 tab（如主会话派探路）              | Paseo `create_agent`（同 workspace、不设 parent，作为顶部 tab）                               |

插件在每个任务 tab 创建时（lifecycle `agent.create`）注入一段固定的中文交流说明和当前 tab 清单；清单变化时 agent 随时可用 `vibe_tabs` 刷新。agent 发给别的 tab 的消息以 agent 身份出现（sourceAgentId），不能冒充用户；因此 `/执行`、`/通过` 等授权只认用户在原生 composer 里的操作。

## 3. 数据与插件

- task（WP-110）仍以 workspace_id 为键；新增 `tabs_json`（编号 → agentId、角色、预设/模型、创建时间）与下一个编号。不再需要 conversation_id、群聊行、成员表、artifact 发布到群聊。
- 方案仍用 vibe-plan 固定格式，由 `/执行` 读取 #1（或用户所在 tab）最近一次完成输出中的方案段确认。
- 复核/验证结论、Git 结果写 vibe.db（verification/evidence 等现有表），并在 #1 时间线 append 一条摘要（不触发模型回合）；`/状态` 在任意任务 tab 显示阶段、各 tab 状态与最近结论。
- 第七轮恢复一个轻量「任务流程」workspace 面板：阶段与阻塞原因、tab 列表（点击用宿主的 `navigation.openAgent` 切换）、各步结论展开，以及执行/通过/停止/状态按钮（与斜杠命令同一服务端命令）。用户触发的状态（`/状态`、确认/排队、准入失败、Git 结果、验证摘要）每条都是新行，相同文本 30 秒内只追加一次；只有看门狗这类纯重复提示固定一行原位更新。验证摘要改用可打开报告与证据的 `task-verification` 卡片。
- 调度（WP-112）、七角色默认、只读角色（**只靠提示词要求不修改文件**，不强制 provider 的只读/plan 权限模式，也不拒绝不支持只读模式的 provider）、Git 收尾安全规则（WP-115 复核后的版本）保留。

## 4. [core]

- 撤掉 WP-111 群聊容器与 WP-115/114 中只服务于它的宿主改动，packages/ 回到「WP-113 合入后（fe473a2d4）」的状态，再保留：旧手机看板副本的删除与旧 card 通知提示（03bfbea55 中相应部分）、中文 slash 命令名（af8b3d77b 中相应部分）、与任务会话无关的普通会话修复（逐项列出理由）。
- 首消息 outbox（WP-113）恢复为普通「建 workspace + 首个 agent」路径，不再交给插件 owner。
- 宿主若缺「插件给 agent 设标题」「插件注入系统说明」等能力，按 fork 规则补最小 [core]（先确认现有 setTitle、agent.create 变换是否够用）。

## 5. 提示词精简（WP-122）

盘点全部注册提示词，只保留：主会话（规划）、探路、方案复核、执行、子任务、复核、验证、tab 交流说明、总 agent 派发与记忆整理、自动维护各规则模板、上下文压缩/交接。合并按场景拆得过细的模板，删除没有调用方的；固定格式段保持只读。

精简结果：注册提示词 **36 → 28** 条。一个场景一条模板；仍然分开的只在阶段或解析器确实不同（验证 setup/judge/review/fix 四阶段、压缩摘要与恢复、维护复核与修复）。固定格式集中在两处：`task.plan_format`（`vibe-plan`）和各角色提示词的 `fixedSuffix`（`vibe-delivery`、当前轮次规则、维护只读约束）。

最终保留清单：

| 插件          | key                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| vibe-shared   | `task.plan_format`                                                                                                                                                 |
| vibe-board    | `task.role.planner`、`task.role.scout`、`task.role.plan_reviewer`、`board.task.work`、`task.role.subagent`、`board.tabs.guide`、`board.task.continuation`          |
| vibe-verify   | `verify.task.setup`、`verify.task.judge`、`verify.task.review`、`verify.task.fix`、`verify.verifier_system`、`verify.reviewer_system`                              |
| vibe-context  | `context.compact_notes`、`context.compact_restore`、`context.cold_start`、`context.failure_handoff`、`context.inject_frame`                                        |
| vibe-master   | `master.task_dispatch`、`master.wake.task_done`、`master.rules`、`master.rules_supplement`、`master.rules_updated`、`master.repair_json`、`master.handoff_summary` |
| vibe-maintain | `maintenance.review`、`maintenance.fix`                                                                                                                            |

合并映射（`register({ aliases })`，仅当新 key 同作用域没有覆盖时才搬移）：`board.task.plan` → `task.role.planner`、`board.task.scout` → `task.role.scout`、`board.task.plan_review` → `task.role.plan_reviewer`、`task.role.worker` → `board.task.work`、`board.task.subtask` → `task.role.subagent`、`task.role.reviewer` → `verify.reviewer_system`、`task.role.verifier` → `verify.verifier_system`。`verify.task.evidence_scope` 无调用方且无替代场景，整条删除；如用户曾覆盖，`orphans()` 会让「Agent 行为」页提示「旧覆盖已失效，请重新设置」并提供删除。被删除 key 的模板行由各插件 `pruneMissing: true` 清理，`prompt_override` 表结构不变。

## 6. 工作包

| 包            | 内容                                                                                       | 依赖 |
| ------------- | ------------------------------------------------------------------------------------------ | ---- |
| WP-120 [core] | 撤群聊容器，packages/ 收敛到 §4                                                            | 无   |
| WP-121        | 插件：tab 编号与清单、交流说明注入、`vibe_tabs`、流程改为开 tab、`/状态`、删面板与容器调用 | 120  |
| WP-122        | 提示词精简                                                                                 | 121  |

每包由 qoder CLI 实现，Claude 复核后合入。验收都要有单测与隔离 daemon 实测：两个不同模型的 tab 用 #编号 互相读记录、发消息，用户开新 tab「继续 #n 的工作」能接上。

## 7. WP-121 实现记录

- **编号与标题**：`vibe-shared` core 迁移 v15 给 task 增加 `tabs_json`、`next_tab_number`；`tasks.allocateTab` 同一 agent 幂等、编号只增不复用。`agent.created` 生命周期调用同一登记函数，标签 `vibe.tab.role` 决定角色，否则首个 agent 为 `main`、后续手动 tab 为 `session`；标题用现有 `agent.setTitle` 写成 `#n 角色 · 模型`。子代理（带 `parentAgentId` 标签）和归档 agent 不登记。
- **交流说明**：`agent.create` before 变换按 workspace 注入 `board.tabs.guide`（当前清单 `{{tabs}}`）、对应角色规则和主会话方案格式；子代理与非任务 workspace 原样放行。清单实时渲染，agent 随时可用 `vibe_tabs` 刷新。
- **`vibe_tabs`**：通过 `registerAgentTool` 注册，要求 `callerAgentId`；返回当前任务阶段、方案目标、自身编号和每个 tab 的编号、agentId、角色、模型、状态。
- **流程改为开 tab**：`/执行` 从当前 tab（找不到则 #1）读取最新 `vibe-plan` 并确认；`scheduler.task_admitted` 到达后由插件在任务 workspace 用 `workspaces.ref().agents.create` 打开带 `vibe.tab.role=worker` 的执行 tab，绑定资源并发送执行提示词；执行 tab 输出 `vibe-delivery` 后进入 reviewing/verifying，vibe-verify 继续以普通 tab 打开复核/验证（提示词要求不修改文件，不强制只读权限，验证 tab 可运行测试）。`/通过` 复用原 Git 收尾安全规则；`/状态` 只向时间线 append 摘要。
- **授权**：`vibe.task.tabs.command` RPC 在 `context.callerAgentId` 非空时拒绝；agent 消息在时间线中是 `tool_call`，`standaloneAccept` 只匹配 `user_message` 的「通过」。
- **删除**：会话内任务面板、客户端群聊 outbox/recipients、`taskConversations` 调用、vibe-context 的群聊成员压缩路径均已移除；首消息 outbox 交回宿主普通路径。
- **偏差**：本 fork 的 Paseo 工具集没有 `wait_for_agent`，等待完成改用 `send_agent_prompt` 的 `notifyOnFinish` 通知及 `get_agent_activity`/`get_agent_status` 查询；设计表已同步修正。
- **[core]**：为让插件完成上述能力，仅新增插件 agent 工具注册/调用（含 `callerAgentId`）、`agent.create` before 请求的 `workspaceId`/`parentAgentId`/`labels`、以及 `create_agent` 的 `asTab`（映射为顶层 `detached`）。详细文件清单见 WP-121 验收报告。

## 8. WP-123 实现记录（第七轮）

第七轮修正第六轮留下的三个缺口：状态消息无法渲染、流程 tab 全部按需打开、没有查看结论的轻量入口。没有新增 `[core]` 改动。

- **状态消息**：`vibe-board` 重新注册 `task-status` 时间线渲染器（中文、首行标题、长正文可折叠）；`vibe-verify` 的验证摘要改以 `task-verification`（带 `workspaceId`/`verificationId`）追加，复用已有的报告/证据展开卡片；`vibe-context` 的上下文提示改为 `context-status` 并同样可折叠。v0.13 的贡献 ID / 渲染器 kind 只接受小写字母、数字和连字符，原来的 `context_status` 会被宿主拒绝注册；这是第六轮后上下文提示变成 unavailable 的原因。宿主按同 id 合并时保留第一行的位置（`timeline-projection.ts` 的 `mergeIdentityEntries`/`collapseByIdentity`），复用 id 会让新状态出现在历史上方并覆盖旧状态，所以 id 规则是：看门狗用 `context-watchdog:<workspaceId>` 原位更新；其它上下文提示与 `task-status` 每条唯一 id；验证摘要用 `verify-status:<verificationId>`（同一轮验证的更新合在一起，不同轮次互不覆盖）。重复抑制在内存里做：同一 tab（上下文为同一任务）相同文本 30 秒内跳过；记录随过期、tab 关闭/归档、workspace 归档和任务完成清理。
- **预建流程 tab**：`provisionTabs` 在任务 #1 登记后按默认模型创建 scout/worker/reviewer/verifier（禁用的可选角色跳过），不带 prompt；角色顺序固定、编号连续。只在活动阶段补建（见第 1 节）。agent 已创建但登记失败时记下其 agentId，下次先补登记，仍失败就归档，不再重复创建孤儿 agent。预建 tab 的权限模式与按需打开的 tab 同源（共享契约 `taskRoleModeId`）：执行沿用预设模式，复核/验证用 `auto`（仅 Claude/Codex 传 modeId），探路保持 provider 默认。`board.tabs.guide` 增加 `self`/`position`/`tabs` 三个占位符，写明自身编号与角色、上下游、其它 tab 职责、`send_agent_prompt`/`get_agent_activity`/`vibe_tabs` 用法和结论交接时机；清单只是创建时的快照，提示词要求以 `vibe_tabs` 的实时结果为准。插件创建的 tab 通过 `VIBE_ROLE` 声明角色，agent 标签不参与角色判定。
- **复用与直接执行**：确认时把已存在角色 tab 的模型冻结进本轮角色快照（`alignRolesToTabs`），调度器按该模型准入；`openWorker` 优先复用已有执行 tab。复核/验证由 `vibe-verify` 通过 `reuseAgentId` 复用预建 tab，但只在该 tab 从未跑过回合、且本轮不要求新成员（`forceNewMember`）时复用，否则新建，保持每轮复核/验证的独立性；复用 tab 的首条消息带上角色规则，提交、工作目录、检查清单等证据信息一律走轮次提示词，不依赖预建时没有的环境变量。
- **执行 tab 的授权语义**：用户在执行 tab 发的原生消息本身就是执行授权，但仍要过调度准入；agent 互发消息带 `<paseo-system>`，不算授权。回合必须有 turnId，且只认属于本回合的用户消息。按阶段：规划/待确认时，有完整 `vibe-plan` 就确认该方案；没有完整方案时，这条消息本身就是任务说明（生成「无方案，按用户在执行 tab 的指示执行」的方案并记入 `control.directInstruction`，`/状态` 和面板都会显示），确认后同样准入。排队/暂停时补做准入。执行中且执行 tab 已持有租约时，用户追问直接放行，不重复准入、绑定或取消。复核/验证/待验收/完成阶段拒绝并停止本轮。准入成功后插件发出执行确认（执行提示词）；预建执行 tab 的提示词写明收到执行确认前不修改文件，用户只是提问时先回答、不改文件。不引入只读模式（第六轮已定不强制只读）。
- **准入竞态**：调度器准入（`workerAdmitted`）与执行 tab 的直接授权都在同一个 workspace 队列里检查阶段，谁先到谁执行，后到的看到阶段已变就直接返回。准入时执行 tab 正在跑回合（通常是用户的直接消息）就保留准入、等该回合的授权绑定；回合结束仍没人绑定时自动重试。失败路径只释放本次调用自己绑定或尚未绑定的准入，不释放另一条路径绑定的租约。执行 tab 的回合记录所属租约代次（`noteTurnStarted`/`takeTurn`），回合结束只释放那一代租约，不会误放新的准入。
- **面板**：`addWorkspacePanel` 注册「任务流程」，用只读 RPC `vibe.task.panel` 返回阶段、阻塞原因、tab 视图与最新结论；该 RPC 与命令 RPC 一样拒绝带 `callerAgentId` 的调用，且不补建 tab。tab 点击使用宿主已有的 `navigation.openAgent`，不需要切 tab 的 [core] API；移动端从 workspace 的「+」插件面板入口或 Command Center 打开。面板按钮调用与 `/执行` `/通过` `/停止任务` `/状态` 相同的 `vibe.task.tabs.command`，`callerAgentId` 校验保持只认用户操作。
- **已知取舍**：宿主没有“发送前”插件钩子，直接在执行 tab 发消息时准入只能在回合开始后补做，模型可能已开始生成；提示词要求收到执行确认前不改文件，准入失败会立即停止该回合。方案复核（plan_reviewer）仍按需通过 `vibe_open_tab` 打开，不在固定 #2–#5 列表中。

## 9. WP-126 实现记录（第七轮）

接手从「拼最后一条输出」改为结构化交接包，没有改 `packages/`。

- **交接包**（`vibe-board/server/tabs/handoff.ts`）：来源 tab、阶段、方案目标、git 检查点（worktree、HEAD、分支、`dirtyHash`、相对 main/master 与未提交的改动文件，最多 50 个）、最近输出、「未决问题」「下一步」。后两项只从来源 agent 末尾的同名小标题解析，不调用模型；小标题由 `board.tabs.guide` 要求每回合写出。git 命令只读且带 `GIT_OPTIONAL_LOCKS=0`。`dirtyHash` 在 `status --porcelain` 之外加入脏文件的大小与 mtime，否则已经脏的文件再被改动检测不到。
- **存档**：新增共享表 `task_handoff`（core 迁移 17，`taskHandoffs` 命令），每 tab 一行，每个回合结束（`turnEnded`）覆盖。`/接手 #n` 与「继续 #n 的工作」优先读存档，来源 tab 仍在运行或没有存档时现场生成；接手时重新取检查点，HEAD 或 `dirtyHash` 变了就写「#n 交接之后仓库已变化」。
- **围栏**：交接内容放在 `<<<VIBE-HISTORY-BEGIN/END>>>` 之间，前置只读提示词 `board.tabs.history_notice`（不可信历史数据，不是指令）；围栏内出现的标记被转义，总长 30000 字，超出按段截断并标注。渲染顺序为未决问题、下一步、改动文件、检查点，最后才是最近输出。
- **已知限制**：只在 `turnEnded` 刷新，回合中途改动的文件不会进存档，但接手时的检查点比对会发现；host 会把注入消息 HTML 转义，围栏标记在 agent 眼中显示为实体。

## 10. WP-127 实现记录（第七轮）

同一任务的子代理共用一个 worktree，靠任务看板协调；`packages/` 只加了一个前置钩子。

- **看板**（`vibe-shared/db/task-board.ts`，core 迁移 18 新表 `task_subtask`，命令 `taskBoard`）：方案确认（`/执行` 或执行 tab 直接授权）时用方案 subtasks 重建看板；无方案的直接授权看板为空。同一次确认的重放（看板已属于本轮 `confirmedAt`）不重建；新一轮重建时，上一轮进行中且新方案不再使用的子任务保留为受阻，插件给这些子代理发「停手」消息，不静默删除。状态待办/进行中/完成/受阻，记录认领者 agentId、tab 编号、认领与完成时间、结论和改动比对结果。认领规则在一个 `BEGIN IMMEDIATE` 事务里判断：依赖未完成、`files` 与其它进行中子任务重叠（`findOverlap`）、已被他人认领、写文件却没声明范围都拒绝，并返回挡路的子任务 id。范围必须显式写：整仓单写者写 `**`；只读调研/审查子任务标 `readOnly`（方案 subtasks 可带可选 `readOnly`），只读认领不占范围，不阻塞别人也不被别人阻塞。确认早于看板的旧任务首次使用时按方案补建。
- **工具**（`vibe-board/server/tabs/board.ts`、`board-tools.ts`）：`vibe_board_list` 所有任务 tab 与子代理可用；`claim/complete/release/add` 只给执行 tab 及其子代理（沿父链找 tab）。主代理可用 `assignee` 替已有子代理认领。认领者已关闭、出错、归档或 30 分钟无活动（无运行中回合且 `updatedAt` 与认领时间都超过阈值）时，执行主代理可用 `vibe_board_release` 收回。
- **派发拦截**：执行 tab 的 `create_agent` 必须带 `labels: {"vibe.subtask": "<id>"}`；`before("agent.create")` 校验并替父 tab 认领，`agent.created` 再把认领移交给新子代理，子任务说明追加进子代理系统提示词。钩子里先写认领、再取 git 基线（5 秒超时，失败就不带基线），慢 git 不会拖垮 `create_agent`。替父 tab 写的认领是「待分配」：60 秒内没有对应子代理就自动退回待办；子代理迟到时由它自己重新认领，再失败就在执行 tab 追加状态（主代理正在回合中时也发消息）。`send_agent_prompt` 原先没有插件拦截点，新增 [core] 前置钩子 `agent.prompt`（入队前、只能改 prompt、抛错即拒绝，用户消息不经过）；执行 tab 给自己的子代理发消息时，放行条件是：子代理持有进行中的认领；或它的 `vibe.subtask` 标签对应的子任务仍由执行 tab 持有（移交中），或已完成（追问、纠错、停手）。其它情况拒绝，提示先认领或先补登。宿主不支持该钩子时插件只记录日志，仍靠 create 拦截、认领拒绝和提示词。
- **越界比对**：认领时记录 HEAD 与已脏文件的大小/mtime；完成时 `git status --porcelain -z -uall` 加 `git diff --name-only <认领 HEAD>`（`GIT_OPTIONAL_LOCKS=0`），只算认领期间新出现或再次变化的文件。重命名的新旧路径都计入（`--no-renames`）。不在本子任务范围、也不在认领期间进行中或完成的其它子任务范围内的文件，以及子代理自报的范围外文件，记为越界；锁文件、`*.snap`、`dist/`、`build/`、`*.generated.*` 内置忽略，子任务可用 `ignore` 追加。只读子任务认领期间出现的写入同样告警。越界写进结论和面板，在执行 tab 追加状态；只有执行主代理正在回合中才 steer 发消息，空闲时不唤醒它。git 快照或比对失败时结论写「越界比对未执行（git 失败）」，不当成没有改动。共用 worktree 无法精确归因，结论里标明是推断。收回（`vibe_board_release` 收回他人认领）时给原认领者发停手消息；`vibe_board_complete` 只接受当前认领者或执行主代理本身。
- **提示词**：`board.task.work`、`task.role.subagent`、`board.tabs.guide` 写明先认领再派发、带标签、有同伴并行改别处、不回滚/覆盖/格式化别人的改动、冲突先协商或交回主代理、越界先改范围、最终答复列改动文件与验证结果。
- **面板与状态**：`vibe.task.panel` 多返回可选 `board`，流程面板显示「任务看板 · 完成 x/y」与每个子任务的状态、认领 tab、范围与结论；`/状态` 加一行看板进度。

## 11. WP-128 实现记录（第七轮）：tab 互通礼仪

借鉴 herdr 的思路（只借鉴，不引入代码）。

- **等审批时拒绝插话**：`board.guardPrompt`（`agent.prompt` 钩子，WP-127 已有）先看目标 agent 的 `pendingPermissions`（实时 `refresh`，任务 workspace 内的 tab 与子代理都算；提问也是待处理请求）。有就抛错：「#n 正在等待审批：<摘要>，请先由用户在 #n 处理，消息未送达」，并要求发送方转告用户，不要替用户回答。用户在应用里处理后再发即可。用户自己发的消息不经此钩子。
- **禁止代答审批**：新增最小 [core] 前置钩子 `agent.permission_response`（`respond_to_permission` 经 `AgentManager.beforeAgentPermissionResponse`，只对 agent 调用者生效，只能拒绝）。`board.guardPermissionResponse` 判断调用者所在 workspace 是任务 workspace 就拒绝：「审批只能由用户处理」。非任务 workspace 的 agent 不受影响；`list_pending_permissions` 只读，保留。旧宿主没有该钩子时插件只记日志，任务 agent 仍可代答。
- **协作约定与终端**：`board.tabs.guide` 增加「tab 协作约定」（不关闭/归档/重置别的 tab、不切换用户焦点、按 #编号/agentId 指定、发出后看回执与 `get_agent_activity`、超时先读记录再决定是否重发、不冒充用户授权）和终端工具说明；执行与子代理提示词加一句不替用户审批。
- **已知限制**：只覆盖本机；对方在回合间没有待处理请求但马上要提问，这类竞态无法阻止；不在任何任务 workspace 的 agent 仍可代答任务 tab 的审批（按需求只限任务 tab 与其子代理）。
