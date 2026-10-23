# 第五轮设计：项目 → workspace → 原生对话

> WP-110 已实现；WP-111…114 待实施。产品决定见 [第五轮需求](../../PRODUCT-REQUIREMENTS.md#第五轮取消看板回到-paseo-对话2026-10-23-用户拍板)；前四轮实现记录见 [ARCHITECTURE.md](ARCHITECTURE.md)。本轮按 WP-110…114 实施。本次只提交文档，不操作用户数据库或日用 daemon，不 push、不合并 main。

## 1. 用户流程与确认边界

一个任务对应一个原生 workspace 和独立 worktree，第一个 agent 是规划 anchor。首消息与原生附件就是任务内容，侧栏就是任务列表，不设卡片字段。非 Git 项目无法建 worktree 时保留输入并说明。

1. **开始**：在项目中新建 workspace，用原生 composer 选择规划 provider/model（或其预设），发送首消息。规划默认取项目覆盖全局，用户原生选择优先。首发前无需设置其它角色。
2. **规划**：用户与规划 anchor 正常对话：提问、回答、要求修改都直接送这个原生 agent。探路只在规划阶段，使用只读 agent。方案以固定格式段输出目标、做法、涉及文件、子任务和验证清单；普通说明仍用中文 Markdown。
3. **方案复核**：`/复核方案` 启动只读方案复核 agent，意见用已有 agent send（带 sourceAgentId）发给规划 anchor，由它在原生对话里修改。用户可重复复核；不另建方案页或消息路由器。
4. **确认执行**：在线输入 `/执行`，或点 anchor timeline 的「确认执行」。插件读取规划 agent 最近一次完整输出中的方案段，校验后保存本轮方案快照、角色快照和确认时间，进入队列。普通文字「确认」「可以」及模型自述都不是授权。
5. **执行**：调度准入后启动主代理，由它请求独立原生子代理执行子任务；都用这个 workspace/worktree。用户要和谁说话，就从原生 Subagents track 打开谁的 tab。
6. **复核、验证**：选了代码复核模型才复核，严重问题退回修复；随后必做证据验证，不提供“不验证”。结果为 pass / doubt / fail，附验证清单结论和证据入口。fail 沿用自动退回上限，doubt 或超限停下等用户。
7. **用户验收**：等待验收时，用户在 anchor 的原生对话单独发送「通过」，触发 §4 的 Git 收尾；「驳回 + 原因」进入修复。普通赞同不代替「通过」。完成后保留 workspace/worktree，再提新要求从规划开始。

方案用明确标记的 JSON 块，含目标/做法、files、subtasks、checks；子任务含目标、方法、注意事项、依赖、文件、验收与可选预设。格式固定，内容由模型生成、用户通过对话修改。格式不完整、规划仍运行或最近输出不可读时拒绝执行，不取旧方案兜底。

确认入口携带原生 timeline 的源定位（epoch/seq 或已有 messageId）；slash 先读取最近输出取得定位，服务端核对它仍是规划 agent 最近完成的输出，再解析保存。不要求可选 messageId 一定存在，不用 revision/hash。数据库事务只允许规划/待确认阶段进入排队，重复点击不会多派。排队或运行中有新方案时，先停止本轮、清空确认时间，重新 `/执行`；旧方案不会被静默替换。重启后已确认且未变化的快照仍有效，但先核对原生 agent 状态，不盲目重发运行请求。

规划 anchor 保持原生规划对话，主代理另开会话。主代理、探路、两类复核、验证挂 anchor，执行子代理挂主代理，用原生 track 逐层打开。聊天、提问、工具记录都留在各自原生会话。

插件只向 anchor timeline append 排队原因、子任务状态、复核结论、验证及 Git 结果，同时更新 vibe.db 的 task 摘要。append 无需持久化；重启只补一条当前状态摘要，原生问答由 Paseo 恢复，不投影历史消息。

anchor 的原生 Stop、timeline「停止任务」或 `/停止任务` 都只走同一个任务停止控制：先撤销排队和新派发，再取消本任务在跑 agent；停止未确认前保留写锁与名额并报告。anchor 空闲时也能停止 worker，不把 anchor 的 idle 当成任务结束。其它 tab 的 Stop 仍只停止该 agent，其取消结果使编排暂停。原生归档前也先停止本任务，再继续归档；原生已有父子级联，但打开的子代理可能被 detach，不能只依赖级联。恢复须核对原生归档与运行状态，必要时由用户执行原生恢复。

## 2. 模型、设置与最小宿主改动

七角色仍为 scout / planner / plan_reviewer / worker / subagent / reviewer / verifier；总 agent 单独配置。项目覆盖全局，临时选择仅影响本任务。anchor 出现后挂现有 composer pill，执行前可改其它角色；规划模型使用原生 composer 当前选择，不扩展无 agent 草稿上的七角色 pill。

原生 profile 只覆盖原生模型选项，不等同于 vibe 的完整预设；vibe planner 默认预设经既有 agent.create 钩子补齐权限、环境和附加指令，首发实际模型以原生选择为准。保留 vibe 预设有序候选、思考强度、权限、环境和附加指令，不按用途过滤；目录外旧值仅供查看。角色选择为继承、指定、不启用三态；不启用只适用于探路和两类复核。主代理、规划、验证必须可用，子代理未选则用主代理。所有角色都使用原生任务 worktree，不让预设另建 worktree。

确认时解析并保存七角色及预设候选快照，默认值后续变化不影响排队任务。临时改角色作用于未启动的会话；换运行中的主代理须先确认旧会话停止，再在同一 worktree 用方案、子任务状态和原生会话链接交接，停止不明就停下。跨 provider 不假设能热切换。模型不可用、额度或登录失败按预设顺序接续；普通任务失败不轮换，候选耗尽报告。显式换模型记录实际选择和摘要，方案范围变化仍须重新确认。

Agent 行为设置集中保留七角色默认、预设、提示词覆盖/恢复默认和插件自动化；固定回复格式段只读，中文说明。总 agent 的模型、派发、权限、自动化和提示词归它自己的设置组，其它入口只链接。项目名称/仓库路径用原生项目编辑；类型、简介、需求路径、并发、设备、七角色默认为项目扩展。多项目规则/覆盖只定义一份，仓库 `.vibe/*.yml` 只作局部覆盖。

### 可直接使用的能力

以下已有，不列为新增 [core]：`addSlashCommand` 的回调可调用插件 RPC；timeline renderer 在插件 RPC context 内，可直接放「确认执行」按钮；`addComposerPill` 已支持 agent；agent create 已有 parent，handle 已有 send、timeline.refetch/subscribe/append 与 resume。依据为 `packages/plugin/src/client/contracts.ts`、`packages/plugin/src/client/rpc-context.tsx`、`packages/app/src/plugins/timeline/view.tsx`、`packages/app/src/plugins/installation-provider.tsx` 和 `packages/client/src/index.ts`。

删掉 C1 和 C2 中的消息路由，不增加首发 metadata、接受凭据、路由 receipt 或宿主持久 timeline。仅按任务 workspace 绑定；插件间继续用 vibe-shared、SQLite 事务与 vibe_event 总线。

### 真正必需的 [core]

- **公开 agent cancel**：`PaseoAgentHandle` 尚无 cancel，已有底层取消不能由插件合法调用。仅在 `packages/client` 暴露调用现有取消 RPC 的 handle 方法，完成/失败语义沿用原生取消合同，用于停止任务与换模型；不增加消息 handler。
- **任务 Stop / 归档前协调**：原生 Stop 只取消当前运行 agent，anchor idle 时不能停 worker；归档 lifecycle 是事后通知。仅给任务 anchor 注册停止控制、任务归档增加前置协调，冻结派发并等待取消再继续；普通 workspace/tab 保持原义。不拦截消息。位置为 `packages/app/src/composer`、`packages/plugin/src/server/lifecycle.ts`、`packages/server/src/server` 的现有取消/归档入口。
- **原生规划默认值适配**：首消息前无 agent pill，插件不能直接给原生 composer 的 provider/model 初值按项目设置覆盖。只给原生模型选择器接入在线解析的 planner 默认/预设初值，用户手选优先，保留原生草稿选择；落在 `packages/app/src/composer`、相关原生模型配置代码，必要的类型合同在 `packages/plugin`。不提供其余角色的首发前配置。
- **手机首消息 outbox**：断线会卸载插件客户端，插件不能保证冷启动离线编辑和重连提交。App 原生 composer/runtime 持有最小 outbox，复用原生创建、附件和消息 API，见 §5；不保留离线插件运行或配置同步。

新增宿主能力在单一边界检查，缺失时提示升级。涉及协议时遵守 [协议兼容规则](../protocol-compatibility.md)，无需旧业务客户端兼容窗口；[core] 和插件实现分开提交。

## 3. 数据与一次性切换

Paseo 保存项目、workspace/worktree、agent 身份及 provider 历史；vibe.db 只保存任务编排和保留能力的数据，不复制原生聊天或项目目录。

| 数据           | 第五轮落点                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目扩展       | 现有 project 表作为项目扩展，以 paseo_project_id 关联原生 projectId，保留类型、简介、需求路径、并发、设备及七角色默认。旧项目按已关联 ID/仓库真实路径匹配原生项目；缺项用原生 API 建项目，歧义停下报告，不复制为第二份项目目录。 |
| task           | workspace_id 为主键，只存 anchor_agent_id、阶段、当前方案快照（含子任务、文件、验证清单）、确认时间、确认时的角色快照、子任务运行状态和结论摘要。不存标题/描述/验收表单，不建 task_event、task_run 或 revision/hash 系统。       |
| 子任务状态     | 放在 task 的结构字段中，保存依赖、原生 agent ID、实际模型、状态及必要接续信息；工作目录/分支从 workspace 查询。当前方案替换前先停止旧运行；过去对话查原生会话。                                                                  |
| 配置与运行资料 | 预设及候选顺序、全局默认、提示词覆盖、维护规则及其按规则×项目的运行计数、记忆、统计保留。移除 card 外键时保留这些记录本身，旧统计可以按原项目/模型/日期查看，不制造伪任务。                                                      |
| 新证据与上下文 | 复用 verification / evidence、agent_session 等现有能力的必要字段，关联 workspace 和本轮确认时间/验证 commit；证据是文件与报告，不是全量消息事件。vibe_event 继续作插件总线，不作聊天档案。                                       |

**旧卡片不迁移。** 3 张旧卡、card_event、卡片附属方案/子任务/证据和旧手机离线积压只留本机数据库备份，不导入、不建 workspace 映射、不回放首消息，不作新任务恢复依据。

切换只做四步：

1. 暂停旧业务写入与派发，确认没有仍在修改文件的旧运行；对 daemon 数据库作一致性本机备份，校验可打开。手机端旧数据库在清理前保留本机备份；备份失败则停止该端清理，不上传仓库或云端。
2. 将上表明确保留的数据迁入简化结构，按配置内容、预设顺序、规则作用域/运行计数和记忆/统计核对。单库修改用 SQLite 事务和既有 schema 版本；不建跨存储迁移 journal/卡片对账体系。
3. 在隔离环境确认新任务可完成规划→执行→验证→Git 收尾后切换新入口；正式升级不自动执行旧任务。新流程可用、备份校验通过后，由迁移直接删除旧卡片及附属表、无消费者的旧同步表，保留配置/记忆/统计表与新证据表。
4. 最后一个包删除旧 UI、CRUD/同步接口、手机看板副本及相关生成物。旧客户端必须升级，不提供兼容窗口或旧写入旁路；旧 card 通知说明入口已停用，不映射成新任务。

原生项目按仓库身份复用；迁移失败保留旧库/备份并报告，不动用户 Git。旧 worktree/原生会话保留。按清单 DROP 旧表、逐文件移除代码，禁止递归删除。

## 4. 调度、验证、维护与 Git 不变量

保留现有插件 ID 与分工，vibe-board 技术 ID 暂留，用户侧名称为“任务流程”。旧界面的删除统一留给 WP-114，前面的包只接通新流程。

| 所有者                                | 收敛后的职责                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vibe-board / vibe-master planning     | workspace 绑定、方案快照/确认、主子代理编排、原生会话接续、timeline 摘要和 Git 收尾；规划问答用 anchor。                                                                          |
| vibe-scheduler / vibe-master dispatch | 调度器唯一负责准入、文件锁、并发与设备；总 agent 只为已确认候选排序，不替用户确认、不负责方案或验收。派发开关默认开，关闭/不可用时按确认时间 FIFO。完成后整理项目记忆与需求文档。 |
| vibe-verify                           | 保留代码复核、验证 pipeline、采集器、证据权限/报告与设备租约；结论回 anchor，详情查证据或原生会话。                                                                               |
| vibe-context / vibe-stats             | 保留记忆注入、复杂度、压缩/交接、看门狗及所有角色失败接续；统计按项目/workspace/角色/模型/日归因，未知价格只报 token。统计只保留按需打开的 screen。                               |
| vibe-maintain                         | 规则一次定义、多项目作用域、触发/每日上限/去重/驳回暂停、手动运行和性能前后对比保留；设置页提供必要运行诊断。                                                                     |
| vibe-shared                           | 合同、数据库、事务命令、总线和模型/提示词解析的单一来源；生成副本由 sync-shared 统一同步，不手改生成物。                                                                          |

调度只接受有确认时间和有效快照的任务。主代理、子代理均计入全局/provider/项目并发，辅助模型也申请相应资源。主代理只编排或等待时让出计算名额，再次工作重新准入，保证并发=1 时也能完成委派。设备/端口沿用原生资源租约，停止未落实不得提前释放。

不同任务按仓库真实身份与规范化 files/globs 互斥，未知文件范围按仓库排他；同一 worktree 的主子代理也不能同时写重叠文件。执行 agent 的权限/工具配置与调度准入一致，禁止另起未经登记的写入者绕过计数；用户直接在 tab 干预后，新增写入仍须先准入，必要时暂停同范围 agent。实现优先复用现有子任务控制工具，不拦截或转发用户普通消息。复核只读，验证只对没有活跃写入者的已收口 commit 给结论，后续代码变化使旧验证失效。

所有维护规则产物统一创建新 workspace，生成中文首消息→规划→待用户 `/执行`。同规则/项目未完成任务只补充新发现并要求变化后的方案重新确认，沿用维护去重记录。不提供规则预授权、fix 直入执行或无人值守修复旁路；运行次数仍按规则×项目统计。

### 用户「通过」后的 Git 收尾

仅在本轮验证完成、等待验收且代码仍对应已验证 commit 时，观察 anchor 原生对话里用户新发的独立「通过」消息，开始自动收尾。只匹配原生 user_message 中 trim 后全文为「通过」的新消息，忽略模型输出、引用与旧消息；内部 agent send 必须带 sourceAgentId，保持 agent-message 身份，不能伪装成用户。重启只按保存的阶段核对结果，不能凭历史「通过」再做一次合并。该观察不消费或路由消息。收尾状态与结果写 task 摘要。

1. 获取 origin main 最新状态，检查任务 worktree、项目本地 main 检出及 Git 状态。有未提交改动、主检出不干净、main 检出条件不满足、合并冲突或目标 commit 已变化时停止并报告，不替用户 stash、reset 或解决冲突。
2. 将任务已验证提交安全合并到项目本地 main：能 ff 则 ff，否则普通 merge，绝不 force。先预检冲突；main 或 origin 的新提交若使合并结果超出已验证代码，停止并要求重新验证，不能把未验证合并结果冒充通过。
3. 自动 `push origin main`，失败记录“本地已合并/未推送”等实际结果；重试先查本地与远端状态，不再重复合并。推送成功才报告 Git 收尾完成；仍保留 workspace/worktree，不自动归档或删除。

本次设计提交仍不 push、不合并 main。项目需求文档编辑器仍只提交该文件、不推送。

## 5. Android / Web 的最小手机离线流程

在线时沿用同一 workspace、原生 agent tab、anchor pill 和确认入口；窄屏用原生侧栏、菜单/sheet、Subagents track。推送保留 vivo / 可选 FCM，最小事件只路由到确切 host + workspace/agent；连接继续直连优先、E2E 中继兜底。

离线只保留“写好新任务首消息，联网自动创建 workspace 并发出”。原生 composer outbox 保存 host、projectId、本机请求 ID、首消息/附件本机引用及原生规划模型选择；本机待发送项明确标为“待联网”，不伪装成权威 workspace。重启不丢正文，重连复用同一原生创建幂等键与 clientMessageId，附件准备好再发首消息；成功后替换为正式 workspace/anchor。失败保留内容并说明，结果不明先查询，不盲目新建。不会自动 `/执行`。

不做已有任务后续消息队列、旧离线看板副本、LWW 同步、旧积压导入或离线配置编辑；提示词、默认模型、预设、维护规则等在线才能修改。原生目录/会话历史已有的离线只读缓存继续由原生 owner 管，不新增一份。离线确认、审批与 Stop 不显示成功。

App 改动集中在 `packages/app/src/{composer,runtime,vibe}`：原生 outbox 取代旧 RPC 仿真、replica/change-store、sync engine、replies queue 和只供看板离线执行的 plugin-cache。删除 registry 的 vibe-board 特殊截获及 layout/bootstrap 调用；通知改 workspace/agent 路由。旧生成 contract/sync 随旧 owner 删除，新合同仍从 vibe-shared 生成。旧手机数据只备份、不进入新 outbox。

## 6. 工作包与可验证验收

依赖：**110 → 111/112/113 → 114**。111–113 可分目录并行，完整联调等 111；宿主合同由 111 统一评审，生成副本由 110 串行同步。

各包均交单测和隔离 daemon 实测证据。只用独立 PASEO_HOME / VIBE_HOME、空闲端口、临时项目，Windows worktree 建在 `D:/devRepoCaches/worktrees`；不重启日用 daemon，不连接真实维护项目，不递归删除。运行改动相关单测、typecheck/lint/格式检查与共享副本检查，禁止全仓测试；真实模型至少一轮，故障边界可模拟，但报告须区分。先验收 Web、Android、服务端，再按用户节奏推进其它客户端。

### WP-110：简化任务合同与保留数据迁移

- **范围 / 目录**：`plugins/vibe-shared/{contract,db}`、`scripts/vibe/sync-shared.mjs` 及现有迁移测试；定义 task、方案固定段、确认时间/角色快照/子任务状态合同，迁入项目扩展、预设、默认、覆盖、规则计数、记忆、统计。提供一致性备份和 schema 事务迁移；旧表删除在 114 启用，不导入旧卡、事件或手机积压。
- **依赖 / 并行**：无；先冻结共享合同，供 111–113 使用，生成副本集中同步。
- **单测验收**：7 项目/3 旧卡 fixture，迁后新 task 为零，保留数据内容与计数相等；失败回滚、备份可读、项目路径歧义报告、三态角色及缺验证模型阻断。
- **隔离 daemon 实测**：复制合成旧库升级、重启，用原生项目 API 验证配置关联；新建一任务能保存/读回快照和状态，旧卡不生成 workspace，原始文件和备份不变。

**WP-110 实际接口（2026-10-23）**

- 合同由 `contract/task.ts` 导出。阶段为 `planning / awaiting_confirmation / queued / executing / reviewing / verifying / awaiting_acceptance / completed / paused / failed`。`parseTaskPlan(output)` 只接受一个完整 `vibe-plan` fenced JSON，结构为 `{goal,approach,files,subtasks,checks:[{text,method}]}`，子任务为 `{id,goal,method,notes,dependsOn,files,acceptance,presetId?}`；不补缺失字段，依赖不可缺失或成环。
- `createVibeStore(db).tasks`（或底层 `createTaskCommands(db,{now?})`）提供 `create({workspaceId,anchorAgentId}) / get / list({phase?}) / setPhase / savePlan / savePlanOutput / saveRolesSnapshot / confirm(workspaceId,{plan?,rolesSnapshot?}) / setSubtaskRun / setSummary`。确认仅允许规划/待确认原子入队，重复确认拒绝；排队/运行的方案须先停止并暂停才能改，改方案清确认、角色和旧运行状态。
- 子任务运行字段为 `subtaskId,dependsOn,state,agentId,actualModel,continuation,summary`；状态为 `pending/running/waiting/completed/paused/failed`，运行中必须有原生 agent 与实际模型，continuation 保存前 agent、摘要与候选序号。事务发布 `task.updated {workspaceId,fields}`，不建 task_event，不参与旧手机同步。
- `resolveTaskRoles(selections,projectDefaults,globalDefaults,getPreset)` 与 `store.modelDefaults.resolveTask(selections,paseoProjectId?)` 解析七角色。临时选择是 `{mode:"inherit"} / {mode:"preset",presetId} / {mode:"disabled"}`；默认配置缺键继承、字符串指定、可选角色的 null 不启用。只允许 scout/plan_reviewer/reviewer 不启用；planner/worker/verifier 缺失或指定预设失效报错，subagent 未设置沿用 worker。快照冻结七角色的有序候选、权限、环境和指令；旧卡接口留到 WP-114。
- 复用 `project`，不新建 project_config。按原生 ID 调用 `store.projectConfigs.get/update`，`link(paseoProjectId,repoPath)` 将唯一旧配置关联原生项目；真实路径多解或已关联其它 ID 则拒绝，无匹配返回 undefined。原生项目创建/补齐沿用 WP-104 的宿主 API，由 WP-111 接入，不由 SQLite 迁移猜建项目。
- core v11 仅新增空 task，保留配置/规则计数/记忆/统计原表原内容。已有磁盘库升级前自动调用 `backupVibeDb(db,{vibeHome?,now?})`，`VACUUM INTO` 后只读 integrity_check；显式数据库路径以父目录作为隔离 home，通常即 VIBE_HOME。新库不备份，重启不重复，失败阻止迁移并回滚；删旧表留给 WP-114。
- `TASK_PLAN_PROMPT`（key `task.plan_format`）在 `store.tasks.create` 事务内注册，中文固定格式后缀只读。WP-111 负责附加后缀、核对最近已完成原生输出定位/规划状态与 Stop；不能以旧快照兜底最新输出读取失败。WP-112 负责调度、文件锁与证据验证，本包不提供运行器。

**验收记录**：共享层 11 个相关测试文件共 144 项通过，脚本相关测试 10 项通过。隔离 home 为 `D:/devRepoCaches/r5-110-home`，用 `dev-daemon.ps1 -HomeDir … -Port 17110` 启动，config 关闭 relay。合成 schema 10 的 7 项目/3 旧卡启动后升至 11、task 为零；备份可打开且旧数据逐行一致。七个 Vibe 插件首次/重启均 running。用原生 project/workspace API 注册合成目录，再用临时脚本调用共享命令关联扩展、创建 task、保存/读回方案并确认；重启快照完全相等、迁移全跳过、备份数量与 SHA-256 不变。最后停止 daemon，17110 已释放。仅测试本包数据/API，anchor 为合成 ID，未运行真实规划模型或 WP-111…114 流程。

**静态检查边界**：vibe-shared 及其它六个消费者插件 typecheck 通过；vibe-board 标准检查仍有本地旧 SDK 的四处 `SettingsSelect.inline` 类型错误。根 lint/format 默认排除 Vibe 插件；取消排除的同规则临时配置实际检查，新增代码无诊断，旧 commands.ts 与默认模型编辑器仍分别有 9/8 条与 HEAD 相同的基线诊断。不重装依赖、不改联接的 dist。另一次使用仓库 SDK 声明的临时类型检查遇到堆内存上限，未作为通过依据。

### WP-111：原生规划、显式执行与 agent 编排

- **范围 / 目录**：`plugins/vibe-board/{server,client}`、`plugins/vibe-master/server/planning`；实现 anchor、slash/确认动作、pill、方案复核 send、主子代理、timeline 摘要、Stop/接续和安全 Git 收尾。最小 [core] 为 `packages/client/src/index.ts` 的 cancel 暴露、任务 Stop/归档前协调及原生规划默认值适配（`packages/app/src/composer` 与必要插件合同）。
- **依赖 / 并行**：依赖 110；与 112/113 分目录并行，公共宿主合同统一负责。旧卡 UI 不在此包删除。
- **单测验收**：普通「确认」不执行，读取最近完整方案、旧动作拒绝、重复执行不多派、改方案重确认；原生 parent/workspace 正确；anchor idle 时 Stop 仍停全任务、归档等待取消，停止不明阻止换主代理；「通过」只在等待验收且验证 commit 有效时收尾，覆盖 ff/merge、脏树、冲突、推送失败重试且不删除 worktree。
- **隔离 daemon 实测**：原生首发→真实规划问答→只读方案复核→修改→`/执行`，启动至少两个子代理，打开各 tab 直接对话；重启原生历史仍在、只补状态摘要。临时仓库配本地裸 origin，用户「通过」后 main 合并并推送；脏树/冲突停下，任务 worktree 保留。

### WP-112：调度、验证、维护、上下文与统计接轨

- **范围 / 目录**：`plugins/vibe-scheduler`、`plugins/vibe-master/server/{dispatch,wake,master,subscription,memory}`、`skills/vibe-master`、`plugins/vibe-{verify,maintain,context,stats}`；以 workspace/task 替换运行期 card 关联，保留资源调度、证据 pipeline、规则计数、上下文与统计，结果只回 anchor 摘要。
- **依赖 / 并行**：依赖 110，可与 111/113 并行；端到端接 111。公共任务命令由 110/111 owner 维护，不各自改一份。
- **单测验收**：已确认准入/FIFO/总 agent 开关；主子代理计数、并发=1 无死锁、跨任务/同 worktree 文件冲突；必验证、fail/doubt、退回上限和 commit 变化失效；维护任何输出模式都待确认、去重与运行计数不丢；记忆/提示词覆盖和统计接续不重复。
- **隔离 daemon 实测**：三个任务在并发=1/2、文件冲突和设备争用下正确排队，未确认任务不运行；真实执行→代码复核→测试/日志与 Web 截图、Android 至少一项证据，失败修复后再验证。Git 体检/性能规则只出方案；核对记忆、需求文件单文件提交、用量归因与通知。无设备的采集器明确未实测。

### WP-113：[core] 手机最小首消息 outbox

- **范围 / 目录**：`packages/app/src/{composer,runtime,vibe,plugins}` 及必要启动/通知入口；只实现首消息离线草稿、重连创建/发送、附件与回执替换，复用原生 API；在线设置不走 outbox。旧手机看板代码删除留给 114。
- **依赖 / 并行**：依赖 110，可与 111/112 并行；宿主合同与 111 协调，最终实测接两包。
- **单测验收**：创建前/后断线、回执丢失、App 重启、重复重连均只建一个 workspace/发一条首消息；host 不串用，附件失败保留正文；离线配置编辑/执行确认拒绝；旧积压不会导入。
- **隔离 daemon 实测**：Android 飞行模式写首消息、杀 App 重开、联网自动发出，桌面看到同一规划但仍待确认；重复网络切换不多建，通知进入准确 tab。Web 窄屏核对同一在线流程，离线不依赖看板插件 bundle。

### WP-114：最终切换与删除旧看板、表及手机副本

- **范围 / 目录**：`plugins/vibe-*` 旧 board/detail/UI、card CRUD/同步合同与命令，`plugins/vibe-shared/db` 删除迁移，`packages/app/src/vibe` 的 replica/sync/local-rpc/replies/plugin-cache、旧生成物及 registry/layout 引用，安装/烟测脚本和 `docs/vibe`、需求文档。逐文件删除，无递归删除。
- **依赖 / 并行**：110–113 全部验收通过后串行执行；负责最终备份校验、保留数据核对和删表，不做旧客户端兼容窗口。
- **单测验收**：备份失败不删旧表；成功后旧 card/card_event 及仅属卡片的附属/同步表消失、task 无旧卡；配置/规则计数/记忆/统计相等；无活动看板/卡片字段/LWW/RPC 仿真引用，旧通知提示升级/入口停用，旧写入不能复活数据。
- **隔离 daemon 实测**：从 7 项目/3 卡合成旧环境升级，核实本机备份后完成手机离线首发→规划/复核→确认→排队→主子代理→复核/验证→用户通过→本地 main 与裸 origin→继续对话。重启、停止、失败各覆盖一次；Web/Android 界面无看板，workspace/worktree 与原生历史保留，使用指南更新为新流程。

## 7. 拍板结果与设计经验

仍需用户拍板的问题：**没有**。旧卡/事件/旧手机积压不迁移，用户「通过」后安全合并本地 main 并 push origin main，维护任务一律先规划并等待确认，均已确定。

开发验证经验：旧迁移 fixture 应固定它要验证的版本边界，不把“倒数一条迁移”当作固定功能迁移；共享源只由 sync-shared 复制，测试启动兼容 Windows PowerShell 5.1 并显式关闭 relay。

本轮经验：问答归原生会话，快照与结论归插件，执行授权归用户；先用原生模型选择，避免为首发前七角色设置引入草稿、路由和恢复协议。
