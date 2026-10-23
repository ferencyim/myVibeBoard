# 第五轮设计第三版：一个任务 = 一个原生会话

> 2026-10-23。第三版取代第二版的“各角色独立 tab、只回传摘要”方案。产品决定见 [PRODUCT-REQUIREMENTS.md](../../PRODUCT-REQUIREMENTS.md#第五轮取消看板回到-paseo-对话2026-10-23-用户拍板)。WP-110 已合入 main；WP-111、115 是新拆分，WP-112/113 按本文调整，WP-114 最后切换。本阶段只改文档，不提交、不操作用户数据库或日用 daemon。

## 1. 目标与宿主事实

**一个任务有一个原生任务会话 tab、一个 workspace 和独立 worktree。** 首消息与附件就是任务输入，不恢复标题/描述/验收表单、五栏、标签或卡片 tab。规划、探路、方案复核、执行、复核、验证在同一条群聊中发言，逐条标明角色及实际模型；子代理在会话内展开。非 Git 项目不能创建 worktree 时保留输入并说明。

成功标准：用户从首发、改方案、换模型到验收始终留在该会话；重启能读完整群聊与各步沉淀；权限请求不丢、不串 agent；切换模型不等于确认执行。

源码核查基线为本地 main 7bfd4717f；以下是现状，不是第三版已经实现的能力。

| 现有能力与依据                                                                                                                                                                                                                                                                                 | 对设计的约束                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [session.ts](../../packages/server/src/server/session.ts) 的 handleSendAgentMessageRequest；[agent-manager.ts](../../packages/server/src/server/agent/agent-manager.ts) 的 setAgentModel / reloadAgentSessionInternal                                                                          | 当前发送指定单个 agent；同一 runtime 换 model 不等于跨 provider 换会话。默认 interrupt 和 clearPendingPermissions 不能直接用于群聊全体成员。                      |
| [agent-timeline-store-types.ts](../../packages/server/src/server/agent/agent-timeline-store-types.ts)、agent-manager.ts、[bootstrap.ts](../../packages/server/src/server/bootstrap.ts)、[timeline-sync.md](../timeline-sync.md)                                                                | durableTimelineStore 只有可注入接口和测试，生产未接线；当前主历史依靠 provider 回放。append 是内存行；强制 hydrate 会按 provider 历史重建，不能承载群聊权威记录。 |
| [agent-panel.tsx](../../packages/app/src/panels/agent-panel.tsx)、[composer/index.tsx](../../packages/app/src/composer/index.tsx)、[agent-controls/index.tsx](../../packages/app/src/composer/agent-controls/index.tsx)、[agent-stream/view.tsx](../../packages/app/src/agent-stream/view.tsx) | pane、发送、模型设置、审批都围绕单 agentId；需增加任务会话适配，复用现有 composer、模型浏览与流渲染。                                                             |
| [插件客户端合同](../../packages/plugin/src/client/contracts.ts)、[timeline/projection.ts](../../packages/app/src/plugins/timeline/projection.ts)、[docs/plugins.md](../plugins.md)                                                                                                             | transformer 仅投影单行；renderer 可放按钮；timeline.append 重启丢失，不能拼成持久群聊。pill 有菜单/RPC，但不拦截发送。                                            |
| [workspace-panels/panel.tsx](../../packages/app/src/plugins/workspace-panels/panel.tsx)、[panel-manifest.ts](../../packages/app/src/panels/panel-manifest.ts)                                                                                                                                  | addWorkspacePanel 支持 agent 上下文，但仅 workspace/explorer 位置，是独立插件 tab，手机也不会自动成为 sheet。会话面板需新增宿主挂载点。                           |
| [lifecycle.ts](../../packages/plugin/src/server/lifecycle.ts)、[agent-lifecycle.md](../agent-lifecycle.md)、[subagents/track.tsx](../../packages/app/src/subagents/track.tsx)                                                                                                                  | lifecycle 只有创建/打开前变换和运行/归档等事后通知，没有普通发送前或归档前协调。parent 与两类 subagent 可复用，现成 track 打开 tab 不等于群聊内展开。             |

## 2. 群聊宿主：稳定容器 + 多个后台原生 agent [core]

### 选型与身份

选择**宿主任务会话容器，按需创建/恢复后台角色 agent**。容器是原生会话视图及持久记录，没有自己的 provider 进程；各后台成员仍用 AgentManager 的普通持久 agent。不要使用 internal helper（它不保证持久历史、插件生命周期和正常归档）。

| 方案                                              | 取舍                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 每次接手都创建一个新 provider 会话、重写上下文    | 容器仍不可少；频繁往返反复转写，丢失 provider 原生工具上下文与缓存。无需保留成员运行态较容易，但接续成本高。                      |
| 按角色/实际配置保留后台会话，按需补上下文（采用） | 复用原生 resume、工具、审批与 usage；只增加成员索引和已见上下文游标。成员空闲可关闭 runtime，身份与历史保留，不要求七个进程常驻。 |

conversationId 是稳定、独立的宿主身份，**不是当前接手者的 agentId**。为复用 WP-110，task.workspace_id、anchor_agent_id 保留：anchor_agent_id 仍指首个规划 agent，作为现有 parent 树的稳定根，不再等同用户所见群聊。新增 task.conversation_id 关联容器；更换规划模型也不改容器或旧 anchor 身份。容器单独保存群聊历史，普通 provider hydrate/reload 只能改该成员的原始历史。

规划 anchor 自身也是成员；探路、方案复核、主代理、复核、验证挂该 anchor，执行子代理挂主代理。**容器成员表才是任务停止/恢复的完整集合**，parent 用于复用原生关系与通知，不依赖它推断全部运行者。七角色、方案与授权规则仍归插件；宿主只管理会话、成员、消息来源和控制入口。创建时在目录/agent.created 可见前持久绑定成员（包括 anchor）；普通 root 自动开 tab、历史/深链及布局恢复均将任务成员映射到 conversation，不能靠事后关 tab 或归档来隐藏。

### 接手、消息与上下文

输入框旁的“谁来接”显示角色、预设及当前实际模型，初值为项目覆盖全局的 planner；复用原生模型目录与完整预设选择 UI。用户选择只决定下一条消息的接手者，消息记录自身携带该选择，不能用稍后变化的全局选择路由。

1. 宿主校验 conversation / workspace / 成员归属，调用任务编排的准入控制，再将正文与附件交给对应后台 agent。客户端沿现有 submission owner 扩展任务会话 transport；不能另用直接 send 绕过正文、附件、clientMessageId 与回执关联。
2. 同一角色/有效配置优先恢复已有成员；换 provider 或不能原生改配置时建立新成员。同 provider 连续对话可复用原生会话，跨 provider 不伪装成 setAgentModel 热切。
3. 成员保存 seenConversationSeq；发送时固定待注入区间的 throughSeq，排除当前待发送用户消息和该成员原生已知的自身输出，避免同一轮注入两次。接手前补它未见的**公开群聊内容与已完成沉淀**，包括用户附件的可访问引用、当前方案/确认状态、探路/复核/验证结论、子任务状态；不复制其它 agent 的私有推理或整份工具日志。上下文注入保持系统/内部来源，不伪装成人类消息，也不再次投影到群聊。
4. 超出上下文窗口才复用 vibe-context 的压缩能力：持久化摘要覆盖的 seq 边界 + 最近原文，保留目标、限制、确认方案、未决问题及证据引用。摘要/缺失附件不能静默丢弃；准备失败就暂停发送并报告。模型“已看到”指公开工作上下文接续，不承诺迁移 provider 私有状态。
5. 只有 provider 确认接受该轮次后，按本次固定的上下文边界推进成员游标，不使用期间继续增长的全局末尾；原生 message receipt 与容器提交共用稳定 delivery/clientMessageId。回执不明先查，不能盲目重新注入或发送。上下文转交不授予新的写权限。

**缓存倒计时与压缩**（2026-10-23 追加）：群聊头部或输入框旁显示当前接手者的提示缓存到期倒计时（最后一次请求时间 + vibe-context 的 provider 缓存时长，标明为估算）；到期前显示「压缩」按钮，手动触发该成员压缩；「到期前自动压缩」沿用 vibe-context 现有设置，默认开启。缓存未过期时在接手者选择器切到别的模型，提示「现在换会多耗 token」。成员按需创建，从未接手过的角色不建 provider 会话、不耗 token。宿主提供成员最后请求时间与压缩入口（111），倒计时/按钮/提示的界面与策略归 115 与 vibe-context（112）。

主对话默认一次一个前台角色工作；忙时消息排队，或用户显式停止当前轮次后接手，不因换选择器自动取消其它成员或清空审批。规划探路、执行子代理可以并行，仍须资源准入与文件互斥。未确认时选 worker 也只能讨论，不能越过执行门槛；provider 权限/工具策略必须落实这一边界。已确认后的日常补充可继续当前范围；新增范围回规划重确认。

### 一条可恢复的时间线

群聊历史存**宿主 PASEO_HOME**，不存 vibe.db，也不由客户端订阅多个流后按时间戳拼接。复用现有 epoch/seq、projected pages、sourceSeqRanges、订阅及补洞语义；扩展 durableTimelineStore 的接口形态，落实生产持久实现和启动接线。容器 store 与普通 agent 的 provider 回放路径隔离，不顺带迁移全部普通会话。

- 一个容器 writer 分配递增 seq。保留人类正文/附件、各角色公开回复、角色切换/失败、子会话入口、关键进展与沉淀入口；发言携带当时的 role / provider / model / thinking、backendAgentId、sourceTurnId 和可用的源 epoch/seq/messageId。重放不依赖当前模型配置或仍在线的 agent 名称。
- 人类提交在群聊只记一次，后台 provider echo、上下文注入、agent send 和重连补流按源身份去重。原生助手 chunks 只在同一成员/turn 内合并，不能跨角色合并；发言开始即固定位置，后续补内容，并行完成按宿主入队顺序显示。
- 容器/成员、源去重锚点、上下文游标与群聊行持久化。**提交落盘后才回 accepted 或推送 canonical 行**；不能把当前后台异步 append、失败只写日志当作可靠提交。复用存储事务/回执，记录投递未决状态；崩溃恢复先核对 provider 结果，结果不明时明确暂停。
- 重启直接读群聊 store，完整历史可分页查看，不需要启动所有成员进程。活跃轮次先核对原生状态，禁止自动重发；重建订阅时补未收口的源输出，无法确定完整性时显示缺口，不制造成功。普通规划 agent 的 force hydrate 不覆盖群聊。
- 群聊保留公开正文；工具全过程、推理与后台细节留在原 provider 原始记录，按需查询。插件 timeline.append 可作临时提示；要保留的里程碑走新的宿主持久 publish 入口，不能重启后仅补“当前摘要”代替历史。

### 子会话、工具、审批与生命周期

每个子代理在群聊是一行“子任务 / 角色 / 模型 / 状态”，点击在当前会话展开分页 transcript；宽屏可原位展开，Android 用原生 sheet 显示同一内容。复用 managed parent 与 provider_subagents 两套记录/transport，provider 子会话仍只读。向 managed 子代理补充要求时，在同一 composer 选择该成员，仍经任务准入。后台角色的完整记录也从各发言“详情”进入。默认不新建侧栏项/独立 tab；内联展开不设置 open-agent-tab 标记，不触发 detach。

工具细节默认折叠，展开复用 ToolCallSlot/详情视图并定位原始源记录。**待审批状态始终可见**：群聊聚合所有成员的 pending permissions，显示角色/模型与待处理卡，回复仍路由原 backendAgentId + requestId；选了另一个模型也不把审批转交给它。工具审批不是执行确认，执行确认也不替代工具审批。

任务 Stop、/停止任务、面板停止与归档/销毁前统一进入容器控制：冻结新派发和排队，取消本任务活跃成员，确认停止后再释放锁、名额及继续归档。取消不明保留资源，不启动替代写者。详情内“停止此轮”只作用于该成员并使编排暂停。普通 agent 的 Stop 不改义。

归档不能只靠 parent 级联：现有已开 tab 或跨 workspace 子代理可能 detach。按容器成员核对；普通用户仍可在普通会话用原生 detach，任务受管成员不提供绕过容器的 detach/另开可写 tab。仅关详情/sheet 不归档；显式归档任务也不自动删除 worktree。

### 兼容与 [core] 边界

普通会话保持现有 agent 路径，任务会话新增原生 tab target 与独立服务，不把 ManagedAgent 改造成多 provider runtime。新能力以 server_info.features.taskConversations 在入口一次判定；新客户端对旧宿主提示升级。新宿主只给声明相应 client capability 的连接发送新容器/时间线形态；旧客户端访问任务群聊应得到升级提示，不能误当规划 agent 继续写入或退化为散开的角色 tab。新增字段可选、新 RPC 用点分命名，不删改旧 wire 合同，遵守 [协议兼容规则](../protocol-compatibility.md)。普通 API 向受管成员发消息也须通过容器准入，防止旧客户端/工具绕过门槛。

最小新增 [core] 集合：

1. packages/server：任务会话容器及创建/恢复、成员索引、路由/上下文准备接口、持久群聊 store/聚合、审批/Stop/归档协调。
2. packages/protocol + packages/client：可选来源信息、任务会话创建/发送/历史/订阅/控制与持久 publish 合同、feature/capability gate；公开 handle cancel，复用现有取消语义。
3. packages/app：单 tab 群聊、接手者控件及 submission 适配、来源标注、子会话/工具展开、成员审批和活动汇总、通知定位；首发 planner 默认解析接入现有模型选择。
4. packages/plugin + packages/app：会话内 panel placement/上下文及任务命令准入、归档前控制的最小宿主接口。任务状态机、七角色解析、提示词、调度、证据和 Git 策略仍归插件。
5. WP-113 的原生首消息 outbox。除此不保留离线插件运行或配置同步。

插件停用或绑定/准入服务未就绪时，受管成员所有新运行入口（普通 API、MCP send、create.initialPrompt 等）均拒绝派发；宿主仍允许读持久历史、停止与处理原有审批，审批不得成为启动新轮次的旁路。流程动作明确不可用。通用宿主能力与插件分别提交，向上游合并时可独立审查。

## 3. 会话内任务面板与流程

采用**插件任务面板内容 + 最小 [core] 会话挂载点**：扩展现有 agent-context panel 的可选会话 placement，保留原 workspace/explorer 用途。传入稳定 conversationId、workspaceId、兼容 anchorAgentId；slash/pill 的任务上下文同样新增 conversationId，兼容 agentId 固定指 anchor，绝不指当前接手者。面板按容器存在和 workspace 归属挂载，不能继续只用普通 agentExists 检查。Web/桌面在会话右侧可收起，Android 从“任务 · 当前阶段”打开宿主 sheet。仅 pill popover 无法提供稳定侧面板；独立 workspace panel tab 也不符合本轮目标，因此不选。

面板只有三组：阶段与阻塞原因；子任务依赖/状态/角色/模型及展开入口；按步骤查看的方案、探路结论、方案复核、执行交付、代码复核、验证清单/证据、Git 结果。点沉淀可读完整内容或跳到群聊源位置；过去步骤仍可查，不被当前摘要覆盖。没有数据就显示未产生，不编造百分比。

按钮与 slash 调用**同一个服务端任务命令**；服务端核对阶段、最新方案来源、确认时间、运行者与验证 commit，按钮禁用只是提示。离线动作不得显示成功。

| 操作           | 命令及阶段效果                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 制定/修改方案  | /制定方案；回 planning，由 planner 组织讨论，探路只在规划阶段。已有执行先停止并撤销确认。                                                                           |
| 复核方案       | /复核方案；可选只读 plan_reviewer 在群聊发言，结论交 planner 修改，仍待确认。                                                                                       |
| 认可方案并执行 | 面板“执行”或 /执行；校验最新完整方案后，保存方案/角色快照及 confirmedAt，原子进入 queued。普通“认可”“确认”“可以”不授权。                                            |
| 执行/修复      | 调度准入后 executing；主代理委派已登记子代理，严重复核问题或验证 fail 退回范围内修复，不再探路。                                                                    |
| 复核           | /复核；选了 reviewer 才做，只读，收口后 reviewing；不能跳过仍在跑的写入者。                                                                                         |
| 验证           | /验证；所有任务必做，按确认方案的 checks 收集证据，verifying → pass 时 awaiting_acceptance。doubt 或退回超限暂停；fail 按现有上限自动修复再复核/验证。              |
| 通过           | 面板“通过”、/通过，或新的人类消息 trim 后全文单独为“通过”；仅 awaiting_acceptance 且验证 commit 仍有效时开始 Git 收尾。模型发言、引用、历史重放及内部消息均不授权。 |
| 停止/驳回      | /停止任务 或面板停止；驳回附原因回修复，新增范围先规划重确认；不释放尚未确认停止的写锁。                                                                            |

沿用 WP-110 阶段，不为“方案复核中”“合并中”再扩建阶段系统，细节放当前步骤控制资料。用户首发 → planner/探路 → 可重复方案复核 → 显式执行 → 调度/主子代理 → 可选代码复核 → 必验证 → 用户通过 → Git 收尾；角色依次在同一群聊发言。

方案继续用 WP-110 的唯一完整 vibe-plan JSON 段，普通说明用中文 Markdown。确认读取**最新已完成 planner 发言的完整源输出**，不是群聊最后一条（可能是探路/复核）或最近一页截断文本；核对成员角色、源 epoch/seq 或 messageId、当前规划空闲及方案未被新讨论取代。格式无效或读取失败拒绝执行，不用旧快照兜底。按钮携带源定位，slash 在线取得同样定位；定位与当前方案不符则拒绝，无需 revision/hash。

更换已确认方案前先冻结派发、停止旧运行，将活跃 subtaskRuns 收口为 paused/failed，再经 tasks.setPhase(paused) → planning 清 confirmedAt 并重新确认；不能直接 executing/queued → planning，沿用 WP-110 的已有阶段合同。角色快照保留确认时默认解析；用户主动换接手模型或失败接续记录为本轮实际覆盖，仅影响后续轮次，不回写冻结默认。未结束旧写者先停止，资源重新准入；改变任务范围/验证方法仍需新方案确认。completed 后在同一会话提新要求回 planning，旧沉淀保留。

## 4. 数据：复用 WP-110，分清宿主与业务

| 所有者                    | 保存内容与新增量                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主 PASEO_HOME           | 原生项目/workspace/worktree、后台 agent/provider 历史；新增 conversation 记录、成员 role/实际配置/parent 索引、接手者、seenConversationSeq/摘要边界、投递状态；持久群聊行与源去重/定位。公开聊天唯一权威在此，vibe.db 不复制聊天全文或再建角色发言表。                                                                                                               |
| vibe.db 的 task（WP-110） | 保留 workspace_id 主键、anchor_agent_id、phase、plan_json、confirmed_at、roles_snapshot_json、subtask_runs_json、summary。新增 conversation_id 唯一关联、plan_source_json（群聊及真实 planner 源定位）、role_selections_json（任务临时选择）、control_json（当前复核/退回次数、verifiedCommit、验收来源及 Git 收尾步骤/结果）。已有原生模型成员/聊天游标不再放这里。 |
| 新 task_artifact          | 按 workspace_id + kind + sourceKey 去重保存里程碑索引：confirmedAt（规划时可空）、来源 conversation/成员/turn/seq、摘要、结构化方案快照或证据/报告/文件引用。覆盖方案、探路、两类复核、执行交付、验证、Git；旧步骤保留，只为用户可查的沉淀建索引，不作全量事件日志。                                                                                                 |
| 现有业务表                | 项目扩展继续 project + paseo_project_id，不新建项目目录；预设候选/全局及项目七角色默认、提示词覆盖、维护规则/规则×项目计数、记忆、统计保留。verification/evidence、agent_session 以 workspace + confirmedAt/验证 commit 关联新任务，不伪造旧任务。                                                                                                                   |

所有 vibe.db 写入走 vibe-shared 命令层；新增迁移续接已合入的 core v11，**不回改 WP-110 的迁移或重建任务表**。新字段可空以便已启动的 112/113 接轨，但未绑定 conversation 的任务不能执行第三版流程，由在线初始化补齐，不造旧卡群聊。

每步沉淀先经业务命令原子保存状态/索引并发 task.updated；宿主 publish 以稳定 sourceKey 幂等写群聊入口。重启从已有 artifact 补漏，不能重复步骤或副作用。聊天先存在、面板后索引时也按相同源定位补齐；不用跨库事务、task_event/task_run 或全量迁移 journal。旧全文仍从宿主、证据仍从报告读取。

**旧卡不迁移。** 3 张旧卡、card_event、卡片附属数据及手机旧积压只留本机一致性备份；不导入、不生成 workspace/容器/伪任务。WP-114 在新流程通过后冻结旧写入、确认无旧写者、校验备份与保留数据，再按清单 DROP 旧表和逐文件清理代码。备份/迁移失败停止，旧库与用户 Git 保留，不做旧客户端兼容窗口。

## 5. 保留能力与 Git 不变量

- vibe-board 技术 ID 暂留，用户侧称“任务流程”；它与 vibe-master planning 负责方案/授权、编排、面板/沉淀及 Git，普通问答转由宿主容器路由。vibe-shared 是合同、事务命令、模型/提示词解析与事件总线单一来源，生成副本只用 sync-shared。
- 七角色保持 scout / planner / plan_reviewer / worker / subagent / reviewer / verifier；项目覆盖全局，完整预设保留候选顺序、思考强度、权限、环境和附加指令，不按用途过滤。仅 scout、plan_reviewer、reviewer 可不启用；planner/worker/verifier 必须可用，subagent 未选沿用 worker。所有成员用任务 worktree，不允许预设另建。模型不可用/额度或登录失败按序接续，普通任务失败不轮换；耗尽报告。
- 调度器唯一负责并发、provider/项目名额、文件锁与设备；总 agent 只排序已确认候选，不替用户规划/确认/验收，完成后整理记忆/需求。派发开关默认开，关闭或不可用按 confirmedAt FIFO。主代理、子代理及辅助模型均登记资源；主代理等子任务时让出计算名额，再次发言重新准入，保证并发=1 能委派。接手者从群聊发送也不能绕过。
- 不同任务按仓库真实身份及 files/globs 互斥，未知范围按仓库排他；同 worktree 写者也不重叠。复核只读，验证只对无活跃写者的收口 commit 生效，后续代码变化使验证失效。保留证据 pipeline、设备租约、看门狗、记忆/复杂度/压缩、全角色失败接续及 vivo/可选 FCM 通知；统计按项目/workspace/角色/实际模型/日归因，未知价格只报 token。
- 维护规则仍一次定义、多项目作用域，保留触发/每日上限/去重/驳回暂停、手动运行及性能对比；所有输出模式都创建任务会话先规划，等用户 /执行。同规则/项目未完成时向同一容器补新发现并重确认，不提供无人值守修复旁路。
- 总 agent 的模型/派发/权限/自动化/提示词集中在自己的设置组；其它 agent 设置保留七角色默认、预设与提示词覆盖/恢复。原生编辑项目名称/路径，插件编辑项目扩展；配置与提示词在线修改。所有新增提示词中文并注册，固定格式只读。

**通过后的自动 Git 收尾**仍为：确认本轮 pass 及目标 commit → 检查任务 worktree、项目本地 main 检出、未提交内容与 origin main 最新状态 → 安全 ff 或普通 merge 到本地 main → push origin main。无有效验证、主检出不干净、未提交改动、冲突或目标变化即停止并报告，不 stash/reset/force，不替用户处理冲突。main/origin 新提交导致合并结果超出已验证代码时，先验证合并结果再要求用户通过，不能拿旧 pass 冒充。

control 保存验收来源、verifiedCommit、实际 mergedCommit、本地已合并/待 push 等结果；重试先核对本地与远端，不重复合并，不从历史“通过”重放操作。push 成功才报收尾完成；workspace/worktree 和会话保留。项目需求文档编辑器仍仅提交该文件、不 push。本次文档工作不执行这些 Git 动作。

## 6. Android 与首消息离线

Android 窄屏以同一群聊为主屏：发言头显示角色/实际模型，长内容与工具默认收起；输入框旁接手者用原生 sheet 选择。固定“任务 · 阶段”入口打开面板 sheet，子会话/证据/工具详情复用宿主 sheet 栈与返回规则，返回恢复群聊滚动和草稿，不新增并列抽屉或角色 tabs。审批徽标始终可见，点开能定位对应后台成员。Web 窄屏同义，宽屏侧面板可同时看进度与对话。

WP-113 仍只做**新任务首消息 outbox**：保存 host、projectId、稳定创建幂等键/clientMessageId、正文、本机附件引用及首发 planner 选择（未选则在线解析默认）。离线项标“待联网”，不是权威 workspace。重连复用宿主创建 journal，得到 workspace + conversationId + 首个 planner 成员，发送并以回执替换本机项；回执丢失按同一 key 查询，结果不明不另建。附件未就绪/宿主不支持群聊时保留输入并说明，不丢正文、不跨 host、不自动执行。

原生创建需把容器注册纳入 journal 的稳定里程碑，在首消息前就绑定群聊归属；插件 task 绑定可幂等补齐，未就绪时禁用流程操作。不要先向普通 planner 发首消息再创建容器而漏记它。

不增加后续消息离线队列、旧积压导入、离线审批/确认/Stop 或离线配置编辑。已有原生历史只读缓存继续由原 owner 管；扩展其序列化以保留群聊来源与子会话引用，不引入第二份聊天库。推送/深链定位 host + workspace + conversation，必要时展开 backend 来源；不再把通知打开成独立验证/执行 tab。

## 7. 重新拆包与验收

依赖：**110 已完成 → 111 宿主、115 编排/面板、112 保留能力、113 outbox → 114 最终切换**。115/112/113 可先按本节接口准备，完整联调依赖 111；115 对接 112 的准入与验证，不复制调度器。公共合同先由 111/115 owner 一起冻结，共享迁移与生成副本串行整合，不让并行包各改一份。

以下为后续实施验收，**不是本次文档阶段已完成的测试**。每包都交相关单测、typecheck、根 lint/format 和必要 sync-shared 检查，以及隔离 daemon 证据；不跑全仓测试。用 scripts/vibe/dev-daemon.ps1，PASEO_HOME/VIBE_HOME 同时独立放在 D:/devRepoCaches/r5-<包号>-home，关闭 relay；沿各包指定端口段（111 用 17111、112 用 17112、113 用 17113、114 用 17114、115 用 17115，冲突则协调空闲端口），不碰 6767/6868。临时 worktree 只在 D:/devRepoCaches/worktrees，不访问真实维护项目，不递归删除，结束停自己启动的进程。真实模型至少一轮，模拟故障与未具备设备的项如实区分；先 Web/Android/服务端。

### WP-110：已合入，保留任务合同与迁移成果

- **范围/目录**：plugins/vibe-shared/{contract,db}、sync-shared 脚本及相关测试；不重做、不回滚。
- **实际接口**：contract/task.ts 的 parseTaskPlan 只接受一个完整 vibe-plan：{goal,approach,files,subtasks,checks:[{text,method}]}；子任务含 id/goal/method/notes/dependsOn/files/acceptance/presetId?，依赖不可成环。阶段为 planning / awaiting_confirmation / queued / executing / reviewing / verifying / awaiting_acceptance / completed / paused / failed。
- **命令复用**：createVibeStore(db).tasks 的 create/get/list/setPhase/savePlan/savePlanOutput/saveRolesSnapshot/confirm/setSubtaskRun/setSummary。confirm 只允许规划/待确认原子入队；改方案清确认/角色/运行状态。子任务存 agentId、actualModel、continuation；变更事务发布 task.updated，不参与旧手机同步。新增来源校验和里程碑命令归 115，宿主来源解析归 111；tasks.ts 中旧“anchor 最新输出”注释与调用方须同步为当前 planner 成员，不再查 anchor.lastAssistantMessage。
- **角色/配置**：resolveTaskRoles 与 store.modelDefaults.resolveTask 解析三态选择及冻结候选；store.projectConfigs.get/update/link 复用原生 ID，真实路径歧义拒绝，不猜建项目。task.plan_format 提示词已注册，115 附加固定后缀并检查最新完整源。
- **迁移/历史验收**：core v11 仅新增空 task；保留原 project/配置/规则计数/记忆/统计与旧表，升级前 backupVibeDb 用 VACUUM INTO + 只读 integrity_check，失败阻止迁移。原记录为共享层 144 项、脚本 10 项通过；17110 隔离 daemon 验证合成 7 项目/3 卡、重启快照与备份不变，仅用合成 anchor，未验真实模型流程。共享层及六个消费者 typecheck 通过，vibe-board 有旧 SDK 的四处 SettingsSelect.inline 基线错误；不将其记为第三版通过。旧表最终删除仍归 114。
- **依赖/并行**：无新执行任务；111/115 只做增量，后续共享副本由 owner 统一同步。

### WP-111：[core] 群聊任务会话宿主

- **范围/目录**：packages/server/src/server/{agent,creation,plugins,session.ts,bootstrap.ts} 的最小接线及新任务会话模块；packages/{protocol,client}；packages/app/src/{panels,composer,agent-stream,subagents,timeline,workspace-tabs,plugins}；packages/plugin/src/{client,server}。实现 §2 的容器/成员、durable store、创建/路由/接续、公开发布与源查询、单 tab/展开/审批、Stop/归档控制、会话面板 slot、feature gate；不实现业务状态机或复制调度。
- **接口交付**：任务会话 create/resolve、send({conversationId,recipient,clientMessageId,...})、fetch/subscribe、publish({sourceKey,...})、stop/archive 控制；上下文准备/准入由插件提供，宿主负责校验与投递。具体 RPC 用 task.conversation.\*.request/.response。向 115 暴露 panel 挂载/源定位，向 113 暴露同创建 journal 的容器/首发幂等结果，向 112 暴露统一成员与实际来源。
- **依赖/并行**：基于 110；先冻结协议/SDK，随后 115/112/113 分目录开发。核心 composer/timeline/创建接口由 111 主改，113 不另加发送通路。111 不接触共享 dist 联接。
- **单测**：跨 provider 与返回旧成员时上下文/附件正确；新成员不读私有推理；人类/echo/注入不重行；并行来源有序、角色快照准确、分页补洞/重启/原 provider hydrate 不丢群聊；持久写失败不 accepted，未知投递不重发；审批不串/Stop 等待取消/归档无漏跑；首次创建、重连、第二客户端及布局恢复无 anchor/角色 tab 闪现，展开不设 open-tab 标记；新旧连接都可解析，普通会话无回归。
- **隔离实测**：两个真实 provider 在同一 tab 交替发言并接续上下文，两个子代理在会话展开；重启后不启动全部 provider 也能翻完整历史，验证流中/接受后断线及补流无重复。触发真实审批，换接手者后仍回正确成员；Stop/归档覆盖后台，普通会话照常。Web 与 Android 窄屏各留证据。

### WP-115：任务面板、沉淀与流程编排

- **范围/目录**：plugins/vibe-board/{server,client,shared}、plugins/vibe-master/server/planning、plugins/vibe-shared/{contract,db} 及生成副本。实现 task 增量字段/artifact 命令、七角色临时选择、面板/slash 共用动作、最新方案确认、阶段编排、主子代理委派、接续、Git 收尾；接 112 的资源与证据服务，不自建 runner/调度。接手消息交 111。
- **依赖/并行**：依赖 110 与 111 合同，可先用合同桩并行做面板/命令；完整运行依赖 111/112。共享合同/迁移集中在本包；112 的已有 schema 改动与本包逐项合并，不重做 v11。旧 UI 删除留 114。
- **单测**：按钮/slash 同权；普通赞同不执行，模型/引用/重放不通过；最新 planner 完整源与旧按钮拒绝、缺格式拒绝、重复确认只派一次、改方案重确认、选 worker 不绕授权；每步沉淀历史/去重/重启补漏；模型变更记录实际覆盖；验证 commit 失效；ff/merge、脏树、冲突、push 失败与重复验收均不误收尾。
- **隔离实测**：首发→探路/方案复核→修改→面板执行→主子代理→复核/验证→面板通过或独立“通过”；全程一个 tab，面板能查看旧步骤和证据。临时仓库配本地裸 origin，核对本地 main 与 push、失败重试及 worktree 保留；Web 侧面板/Android sheet、重启、停止各覆盖。

### WP-112：调度、验证、维护、上下文与统计（调整现有并行包）

- **保留范围/目录**：plugins/vibe-scheduler、plugins/vibe-master/server/{dispatch,wake,master,subscription,memory}、skills/vibe-master、plugins/vibe-{verify,maintain,context,stats}。task/workspace 准入、并发/冲突、证据 pipeline、规则计数、记忆/统计改造继续，毋需推倒。
- **仅改接点**：结果从“anchor 摘要 + 独立角色 tab”改为 111 publish + 115 artifact；创建/运行验证、复核、维护规划统一经任务会话服务挂成员。上下文按 conversation 公开历史与成员游标接续，usage 仍按真实 backend agent 记一次；通知以 conversation 定位。调度、租约和重试算法不搬到宿主。
- **依赖/并行**：已有 110 可继续，接口先对齐 111/115；与 113 分目录并行，端到端等 111/115。新增共享字段由 115 owner 集成。
- **单测**：确认准入/FIFO/总 agent 开关、所有成员计数、并发=1 无死锁、跨任务/同 worktree 写冲突；必验证、fail/doubt/退回上限/commit 失效；维护全模式先方案确认/去重计数；来源、证据索引与 usage 重放不重复。
- **隔离实测**：三任务在并发=1/2、文件和设备争用下正确排队；执行/复核/验证发言在同一群聊，Web 截图/日志与 Android 至少一项真实证据；验证失败修复再验。Git/性能维护只出方案，核对记忆/需求整理、统计与通知；无设备项明示未测。

### WP-113：[core] 手机首消息 outbox（调整现有并行包）

- **保留范围/目录**：packages/app/src/{composer,runtime,vibe,plugins} 与必要启动/通知入口；正文/附件持久化、重连、幂等/回执逻辑继续，仍只首消息，不扩展离线产品范围。
- **仅改接点**：创建/成功回执目标由 workspace + planner agent 改为 workspace + conversation + planner member，复用 111 的创建 journal，第一条消息就在群聊。接手者初始选择用 planner 配置；通知/恢复打开任务 tab，不再打开后台 agent。群聊缓存来源字段配合 111 保留，勿另建离线聊天副本。
- **依赖/并行**：基于 110，可继续 outbox 本机状态机；和 111 协调 composer/创建 transport，不重复修改，端到端等 111/115。
- **单测**：创建前后断线、回执丢失、杀 App、重复重连仅一 workspace/一容器/一首消息；host 隔离、附件失败留正文、缺 capability 留草稿；无后续消息/配置/授权入队、无旧积压导入。
- **隔离实测**：Android 飞行模式首发→杀 App 重开→联网自动创建群聊，桌面看到同一首发仍待确认；多次断连不多建，附件及通知正确定位。Web 窄屏复核在线流程；不依赖旧插件离线 bundle。

### WP-114：最终切换与删除旧实现（依赖增加）

- **范围/目录**：plugins/vibe-\* 旧 board/detail/card CRUD/同步、vibe-shared 删除迁移、packages/app/src/vibe 旧 replica/sync/local-rpc/replies/plugin-cache 及生成物/registry/layout 引用，安装/烟测脚本和 docs/vibe/需求。逐文件移除，禁止递归删除。
- **调整/依赖**：从等待 110–113 改为**111、112、113、115 全部验收后串行**；最后删除第二版独立角色 tab 入口/仅补摘要恢复路径。保留宿主原始记录详情、普通会话、受管 parent 与 provider-subagent transport；不能误删新群聊所用原生缓存/子会话能力。
- **单测**：备份失败不清理；迁后 task 无旧卡，旧表/积压消失而配置/预设顺序/计数/记忆/统计相等；无看板/LWW/旧写入旁路；群聊永久历史与 artifact 不因清理丢失，旧客户端/通知提示升级或停用。
- **隔离实测**：合成 7 项目/3 卡旧库升级，备份可读、新 task 为零；手机离线首发→同会话换模/面板方案确认→排队/主子代理→复核/验证→通过→本地 main 与裸 origin。覆盖重启/停止/失败，Web/Android 无角色 tab 散落，worktree 与群聊/沉淀保留，更新使用指南。

## 8. 风险、拍板与经验

**当前无需新增产品拍板。** 单会话、七角色、旧卡不迁移、必验证、维护先确认、通过后自动合并/push、手机仅首消息均已确定。本设计选择容器多成员、宿主持久历史和插件面板 + core slot，不改变这些范围。

| 风险/选项                                      | 决定与验证边界                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 跨 provider 上下文窗口不同；全部转写或摘要接续 | 采用未见公开上下文，超限才摘要 + 最近原文；摘要边界/未决项可查，不承诺 provider 私有推理迁移。111/112 用真实双 provider 验证。                                            |
| 简化成插件 append 或客户端拼流，工期更短       | 不采用：重启、顺序、审批身份和来源去重无法保证。111 必须先交 durable 恢复，115 不能靠“重启补摘要”验收。                                                                   |
| 并行 112/113 已有第二版代码                    | 保留其算法/本机状态机，只换会话入口和结果落点；公共合同先冻结、共享迁移由 115 合并，避免各包复制路由。旧 WP-111 若有未合工作，仅择取业务逻辑到 115，不把多 tab 方案合回。 |
| 同 worktree 多 agent 与断线后的未知投递/取消   | 准入和文件互斥在每个写者入口落实；不明即暂停，核对后接续，不能用换模型制造第二个写者。                                                                                    |
| 宿主改动多于第二版                             | 代价来自真正的单会话多 provider 与可恢复历史；通过独立容器服务、复用原生 agent 和最小 panel slot 控制改动，不泛化成任意群聊平台。                                         |

长期经验：先核查宿主实现再承诺复用；声明式扩展点不等于生产持久化，workspace panel 不等于会话侧面板。聊天/来源归宿主，步骤沉淀/编排归插件，业务授权只取显式用户操作。旧迁移 fixture 固定版本边界，共享副本由脚本同步，Windows 隔离实测兼容 PowerShell 5.1 并明确关闭 relay。
