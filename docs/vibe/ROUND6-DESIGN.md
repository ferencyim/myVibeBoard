# 第六轮设计：原生多 tab，tab 之间互相交流

> 2026-10-24。需求见 [PRODUCT-REQUIREMENTS.md](../../PRODUCT-REQUIREMENTS.md) 第六轮。取代 [ROUND5-DESIGN.md](ROUND5-DESIGN.md) 第三版中的群聊容器（WP-111）与会话内任务面板（WP-115 的 panel 部分）；第五轮的数据合同（WP-110）、调度/验证/维护/统计接轨（WP-112）、手机首消息 outbox（WP-113）、旧看板删除（WP-114）继续有效。

## 1. 用户看到的样子

- 一个任务 = 一个 workspace（独立 worktree）。顶部 tab 就是流程，每个 tab 是一个普通的 Paseo agent 会话，标题为 `#编号 角色 · 模型`，例如 `#1 主会话 · Sol`、`#2 探路 · deepseek-flash`、`#3 执行 · Sol`、`#4 复核 · Opus`、`#5 验证 · deepseek-flash`。编号在任务内从 1 递增、固定不变，关掉的 tab 编号不复用。
- `#1 主会话` 由首条消息创建，负责整理需求和出方案，可以派探路 tab。用户在 #1 里确认方案（`/执行`），插件开执行 tab；执行完自动开复核（选了才开）、验证 tab；验证通过后用户 `/通过`（或单独发「通过」），插件做 Git 收尾。
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
- 调度（WP-112）、七角色默认、只读角色（**只靠提示词要求不修改文件**，不强制 provider 的只读/plan 权限模式，也不拒绝不支持只读模式的 provider）、Git 收尾安全规则（WP-115 复核后的版本）保留。

## 4. [core]

- 撤掉 WP-111 群聊容器与 WP-115/114 中只服务于它的宿主改动，packages/ 回到「WP-113 合入后（fe473a2d4）」的状态，再保留：旧手机看板副本的删除与旧 card 通知提示（03bfbea55 中相应部分）、中文 slash 命令名（af8b3d77b 中相应部分）、与任务会话无关的普通会话修复（逐项列出理由）。
- 首消息 outbox（WP-113）恢复为普通「建 workspace + 首个 agent」路径，不再交给插件 owner。
- 宿主若缺「插件给 agent 设标题」「插件注入系统说明」等能力，按 fork 规则补最小 [core]（先确认现有 setTitle、agent.create 变换是否够用）。

## 5. 提示词精简（WP-122）

盘点全部注册提示词，只保留：主会话（规划）、探路、方案复核、执行、子任务、复核、验证、tab 交流说明、总 agent 派发与记忆整理、自动维护各规则模板、上下文压缩/交接。合并按场景拆得过细的模板，删除没有调用方的；固定格式段保持只读。

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
