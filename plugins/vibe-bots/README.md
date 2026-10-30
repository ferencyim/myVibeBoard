# vibe-bots

WP-138 的 bot 服务与临时资料页。依赖 Paseo `>=0.13.0 <0.14.0`、vibe-board（项目能力、默认模型、结构化交接）与 vibe-scheduler（规则派发与排序）。后续 WP-139/140 替换侧栏与资料界面，例程、旁线程和 HTML 卡片不在本包。

## 数据与迁移

数据库沿用 `$VIBE_HOME/vibe.db`，owner 为 `vibe-bots`。共享源在 `plugins/vibe-shared`；修改后运行 `npm run vibe:sync-shared`，不手改生成副本。

- `bot` 保存稳定身份、模型与通知配置、主 agent、待应用标记和归档时间。
- `bot_memory` 保存个人偏好与经验，记录来源、置顶与更新时间。
- `project_default_bot` 将宿主项目 id 关联到默认 bot。
- `bot_legacy_migration` 记录旧来源，事务内创建 bot，重启不重复导入。
- `bot_model_state` 保存备用候选的位置。
- `bot_continuation_request` 保存独立 bot 压缩/失败接续请求，忙时和重启后继续处理。

旧总 agent 迁移为「助手」，角色说明采用可编辑的通用说明，不迁移旧调度角色提示词，旧项目 agent 迁移为各项目的「项目 bot」并设为默认；保留 agent id、会话和现有标签。标签补写失败可重试。归档 bot 保留数据和历史；默认项目 bot 的归档需要同项目替代 bot。

主对话懒创建，带 `vibe.bot=<id>`、`vibe.bot-thread=main`。项目 bot 另带 `vibe.role=project` 与 `vibe.project_id`，继续通过 vibe-board 接需求、开任务、续接与维护项目记忆。系统环境通知和完成整理只发给默认项目 bot。项目 cwd 为仓库根；新独立 bot cwd 为 `$VIBE_HOME/bots/<id>`，迁移来的原会话保持原工作目录。

## RPC 与工具

RPC：`bots.list/create/update/archive/open`、`project.default_bot.get/set`、`models.list`、`memories.list/add/update/remove`。列表包含记忆，供现有客户端同步周期持久缓存。资料与记忆写入需要联网；离线只读。面向用户的写入和包含个人记忆的列表拒绝 agent caller，agent 使用以下工具：

| 工具 | 范围 |
| --- | --- |
| `vibe_bot_read` | 自己或同主机其它 bot 的公开资料，不返回个人记忆或密钥 |
| `vibe_bot_update` | 只修改自己；权限只能收紧 |
| `vibe_models_list` | provider 模型、默认模型、思考强度，支持 query |
| `vibe_bot_create` | 独立 bot 可建两类；项目 bot 只可建同项目 bot，不能给新 bot 放宽权限 |
| `vibe_memory_add/update/remove/list` | 只操作自己的个人记忆 |
| `vibe_projects` / `vibe_project_tasks` | 独立 bot 只读查看各项目与任务；项目 bot 只可查看本项目任务 |
| `vibe_create_task` | 独立 bot 指定 projectId，项目 bot 限本项目；共用真实用户消息授权、附件、幂等创建和流程预建 |

通知设置通过宿主 `agent.notification` 钩子抑制原生提示和推送；保留 attention 状态。所有设置入口与工具共用校验。未知模型或思考强度使用中文错误并列出可选值。模型变更忙时保存为待应用，空闲时同 provider 调宿主 `setAgentModel` / thinking / mode；跨 provider 用 vibe-board 的 `/接手` 交接包开新会话，更新主 agent，保持 bot id、记忆和旧历史可读。备用模型沿用预设候选与备用预设顺序，再接 bot 自设备用链。

独立 bot 不自动派发。vibe-scheduler 提供 `vibe_scheduler_read` 和 `vibe_queue_reorder`，只有独立 bot 主对话可用；排序操作保存顺序与理由，仍由调度器进行资源准入和派发。

## 个人记忆

置顶优先，其余按最近更新时间选择；注入块最多 4000 字符，超出截断并标注。个人记忆不写进仓库 AGENTS.md/CLAUDE.md，项目文件仍是项目记忆真相源。

主对话创建及换 provider 重建时，已有记忆写入系统提示。`bot_memory_delivery` 按原生 agent 保存已送达快照版本（可识别删除和同毫秒修改）；之后 `agent.turn_context` 只返回新增、修改、删除差异，无变化不附加。实际 provider turn 前以 user-role 前置 `<paseo-system>` 围栏块，明确来源是系统且不构成执行授权。provider 接受回合后通过 `agent.turn_context_delivered` 确认快照；失败重试不会丢失差异。真实用户消息、授权事件与客户端消息 id 保留原文。旧主对话首次使用与以后用户修改说明时，同一通道一次性送达新角色说明并撤销旧职责；无变化不重复附加。

## 验证

在仓库根执行 `npm run vibe:sync-shared:check`、`npm run vibe:check-plugins`，在插件目录执行 `npm run typecheck`。插件默认被根 lint 忽略，需用无 ignorePatterns 的临时配置严格扫描新增文件。本包未运行 Vitest 或格式化；定向测试与三端实测清单见 `WP138-REPORT.md`。

## 总协调与 bot 消息（WP-173）

- `bot.role='coordinator'` 全局唯一（迁移 v4）。旧「助手」迁移为「总协调」（用户已改名则保留），不可归档，`bots.coordinator.transfer({toBotId})` 转移。
- 总协调主对话独有 `vibe_hub_status/queue/pause/resume`、`vibe_directive_issue/list/revoke`，转调 vibe-scheduler 的 `hub.*` RPC，中枢不可用时返回中文错误。
- 所有 bot：`vibe_bot_message({to, text})`（表 `bot_message`；项目 bot 只可发总协调与同项目 bot；目标忙时回合结束后投递；同一对 bot 10 分钟超过 6 条暂停投递并通知总协调）。
- 其它插件通过 RPC `bots.notify({target:"coordinator"|{projectId}, text, source})` 投递系统消息（中枢事件用 `target:"coordinator"`）。
- vibe-board 提供只读 `vibe_tasks_overview`，并在任务进入待确认/待验收/失败时通知项目默认 bot。
