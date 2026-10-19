
# 自制 Vibe Coding 工具执行计划（fork Paseo）
 · 

## 目标与范围
在 fork 的 Paseo 上自研一套个人 vibe coding 工作台：电脑上的 daemon 是主服务，统一驱动 Claude Code、Codex、Kimi、DeepSeek 四个 agent；Android 手机可离线编辑看板、远程查看会话并回复提问；总 agent 负责评估草稿、派发任务和组织验收取证。开工前只需确认文末的三个问题。

| 项
 | 决定
 | 
| 基座
 | fork getpaseo/paseo（Apache-2.0）；自研功能尽量写成仓库内插件，核心只改手机离线、同步和中继推送
 | 
| Agent
 | Claude Code、Codex（内置 provider）、Kimi（内置 ACP 目录）、DeepSeek（Deepseek Harness 插件）；其他 provider 一律关闭
 | 
| 客户端
 | 桌面端 + Android；单用户
 | 
| 连接
 | 局域网 / Tailscale 直连优先，自建 E2E 中继兜底；中继服务器部署时再定
 | 
| 看板
 | 草稿箱、待办、进行中、待验证、已完成五栏；执行 agent、标签、“需要验证证据”勾选
 | 
| 总 agent
 | 默认 Claude Opus，订阅由你手动切换；项目不设预算，按卡片优先级调用；子 agent 由总 agent 选
 | 
| 上下文
 | Orbital 式项目记忆文件（只借设计，不复制其 GPL-3.0 代码）
 | 
| 压缩
 | 只在会话空闲且缓存即将到期时触发，与上下文大小无关
 | 
| 验证
 | 覆盖全平台与软硬件：模拟器、浏览器、测试、仿真、硬件在环
 | 不在范围内：多人协作、iOS 客户端、OpenCode 及其他 agent、项目预算。

## 代码基线与仓库结构
fork 为私有仓库，保留 upstream 指向官方 getpaseo/paseo，每两周合并一次上游 release。plugins/ 下的改动不影响合并上游，packages/ 下的核心改动在合并时需人工处理。

| 位置
 | 内容
 | 来源
 | 
| plugins/vibe-board/
 | 看板：五栏、执行 agent、标签、验证勾选、卡片事件
 | 引入 Tasks 插件源码（Apache-2.0）改造
 | 
| plugins/vibe-verify/
 | 验证证据流水线
 | 自研
 | 
| plugins/vibe-master/ + skills/vibe-master/
 | 总 agent
 | 自研
 | 
| plugins/vibe-context/
 | 记忆文件、注入、缓存到期前压缩
 | 自研，参考 Orbital 设计
 | 
| plugins/vibe-scheduler/
 | 资源监控、优先级出队、模拟器与开发板池
 | 自研
 | 
| plugins/vibe-stats/
 | 用量索引与总览页
 | 解析逻辑参考 ccusage（MIT）
 | 
| plugins/switch-provider/
 | 会话内切换 agent
 | 引入 Switch provider 插件（MIT）
 | 
| packages/app
 | Android 端：本地 SQLite、离线看板、会话汇总页
 | 核心改动
 | 
| packages/server
 | 同步 synchronizer、插件离线数据接口
 | 核心改动
 | 
| 中继（paseo-relay）
 | FCM 推送转发
 | 核心改动
 | 核心改动单独提交，提交信息加 [core] 前缀，合并上游时便于定位冲突；能通用化的部分（插件离线数据接口、推送转发）尝试提 PR 回上游。
每个插件声明支持的 Paseo 版本并带回归测试；合并上游后先跑插件测试。
保留 Paseo、Tasks 的 Apache-2.0 声明和 Switch provider、ccusage 的 MIT 声明。

## 总体架构
daemon 跑在电脑上，客户端经直连或中继接入，daemon 以子进程驱动四个 agent CLI。
图中强调色为自研插件，第二种颜色为需改 Paseo 核心的部分，其余为 Paseo 现有能力。

## 模块设计

### M1 Agent 接入

| Agent
 | 接入方式
 | 前置条件
 | token 日志
 | 
| Claude Code
 | 内置 provider
 | 已登录 claude
 | ~/.claude/projects/**/*.jsonl
 | 
| Codex
 | 内置 provider
 | 已登录 codex
 | ~/.codex/sessions/**/rollout-*.jsonl
 | 
| Kimi Code CLI
 | 内置 ACP 目录选 Kimi（说明）
 | 终端先完成 kimi 登录
 | ccusage 已支持
 | 
| DeepSeek
 | Deepseek Harness 插件
 | dsh ≥ 0.1.5-rc.1 已登录并在 PATH；Node ≥ 22.19
 | 需确认 dsh 日志位置
 | 其他内置 provider 在默认配置里关闭。会话内切换 agent：Claude Code 与 Codex 之间由 Switch provider 插件转换为对方的原生会话格式，带完整历史继续；切到 Kimi、DeepSeek 时把完整记录存成 Markdown 让新 agent 先读；两种情况都由项目记忆文件兜底。agent 选择器旁显示各 agent 剩余额度。

### M2 看板
顶部 tab 第一个是总看板（所有项目卡片，按项目着色、可筛选），其后每个项目一个 tab。

| 栏目
 | 进入条件
 | 执行 agent
 | 系统动作
 | 
| 草稿箱
 | 手写或手机离线新建
 | 用户预选（可留空）
 | 总 agent 评估：推荐 agent 及理由，把验收标准拆成检查项
 | 
| 待办
 | 你确认评估
 | 用户预选，或一键采纳推荐
 | 按优先级排队，等调度器放行
 | 
| 进行中
 | 派发：建 worktree + 启动会话
 | 可在会话内切换，卡片记录切换历史
 | agent 提问时卡片亮红点并推送
 | 
| 待验证
 | 会话结束自动进入
 | 独立验证 agent（总 agent 挑选）
 | 勾选“需要验证证据”时生成证据包；否则只跑测试和 lint
 | 
| 已完成
 | 你看完证据点“通过”
 | —
 | 合并或开 PR，清理 worktree，总 agent 把结论写回项目记忆
 | 执行 agent 字段存预设（provider + 模型 + 思考强度 + 权限模式 + 运行环境）。你预选的与总 agent 推荐不一致时并排显示，由你选；未预选时默认采纳推荐。
标签可多选：bug、新功能、修改需求为默认，另预置重构、测试、文档、调研；标签决定默认验证策略。
退回：验证失败的检查项自动把卡片退回“进行中”，失败证据作为下一轮提示词发给原会话；你驳回时同理。
草稿讨论会话：每张草稿卡片可以打开一个与总 agent 的讨论会话，你们可以来回讨论多轮，直到方案完善，再由你手动转入待办。
会话形态：每张卡片一个独立的规划会话（用总 agent 的模型和规则），而不是塞进总 agent 的主会话，避免多张卡片的讨论互相污染、撑大总 agent 的上下文。规划会话启动时读入卡片内容、项目记忆和相关卡片。
可派子 agent：讨论中需要读代码、查资料、估算改动范围时，规划会话可派只读子 agent，结果回到讨论里。
方案落到卡片：每轮讨论后，规划会话把共识写回卡片的结构化字段（描述、检查项、拆分出的子卡、标签、推荐执行 agent），卡片保留方案版本历史；讨论原文挂在卡片的“讨论”页签里。
转入待办只由你触发：总 agent 可以提示“方案已可执行”，但不会自己移动卡片。转入时规划会话生成交接摘要写入会话 .md，执行 agent 从这份摘要开始，然后规划会话归档。
手机端：讨论页与会话详情页一致；离线时可以先写下一轮的回复，重连后发送。

### M3 验证证据
卡片勾选“需要验证证据”后（新功能、修改需求默认勾选），任务结束时由 agent 实际运行成果，把证据附在卡片末尾，你只看证据判断是否符合最初想要的结果。
定义目标：草稿里写验收标准，可附参考图；总 agent 把它拆成逐条检查项并指定验证方式。
独立验证：验证 agent 不是写代码的那个，只读代码、不能改代码。
按项目类型取证：

| 项目类型
 | 运行方式
 | 证据
 | 
| Android App
 | 无头模拟器（emulator -no-window，AVD 快照启动）装 debug 包，用 Maestro 流程或 adb 操作
 | 每个检查项的截图、关键流程录屏转 GIF、logcat 崩溃检查
 | 
| iOS App
 | iOS 模拟器（xcrun simctl），需要 macOS 主机
 | 截图、录屏、崩溃日志
 | 
| Web
 | Paseo 内置浏览器或 Playwright 打开 dev server
 | 桌面宽度与手机宽度截图、交互 GIF、控制台错误
 | 
| 桌面应用
 | 构建后启动，系统截图或 UI 自动化
 | 窗口截图、操作 GIF、日志
 | 
| 后端 / CLI / 库
 | 单元与集成测试，按检查项构造请求
 | 测试报告、请求与响应样例
 | 
| 嵌入式固件（无板）
 | QEMU、Renode 或 Wokwi 仿真
 | 仿真串口日志、仿真屏幕截图
 | 
| 硬件在环（有板）
 | probe-rs / OpenOCD 烧录，串口读日志；可选 USB 摄像头、sigrok 逻辑分析仪
 | 串口日志、设备照片、波形截图
 | 
| 任何 UI 改动
 | 改动前后各截一次
 | 前后对比；有参考图时并排
 | 证据包：卡片末尾一个“验证结果”区块，顶部一句结论（全部通过 / 有存疑 / 有失败），下面逐条列出检查项、证据缩略图和判断；证据带采集时间和 commit 哈希。
你的操作：一键“通过”或“驳回 + 一句意见”；存疑项高亮。
设备资源：模拟器、开发板、调试器、摄像头登记为独占资源，由调度器排队；没接板时降级为仿真取证并在证据包注明；烧录类操作需在卡片上预先授权。

### M4 总 agent
总 agent 是一个长驻的 Paseo 会话，由插件在事件发生时唤醒（草稿新建或修改后 30 秒防抖、卡片完成、会话求助），通过看板 MCP 读写卡片，通过 Paseo 编排能力派发子 agent；规则写在 skill 里。草稿评估输出结构化 JSON，写成卡片评论：
需求是否清晰、需要你回答的澄清问题；
与已有卡片的重复或冲突；
拆分建议与建议标签；
规模估算与推荐执行 agent（附理由）；
风险点与验收检查项。
订阅：默认 Claude Opus，由你在设置或手机上手动切换（如切到 Codex 最高档）；额度偏低或报额度错误时只推送提醒。状态都在看板和记忆文件里，切换不丢上下文。
调度：项目不设预算；额度紧张时按卡片优先级分配，高优先级先拿强 agent，低优先级排队或改派。
子 agent 选择：依据各 provider 剩余额度（providers.listUsage()）、本机资源（CPU、内存、模拟器池、开发板）、能力表（各 agent 擅长什么，及 workers/&lt;agent&gt;/MEMORY.md 里的历史表现）和任务需要（标签、规模、平台）；你预选的优先。
不干重活：读代码、查日志、跑测试都派给子 agent，只收结构化摘要；system prompt 按静态 / 半静态 / 动态分段，提高前缀缓存命中。

### M5 上下文与自动压缩
项目记忆存成项目目录里有上限的 Markdown 文件，总 agent 是唯一写入者；每个执行 agent 上场前从这些文件冷启动。

| 层级
 | 文件
 | 内容
 | 写入者
 | 
| 用户
 | ~/.vibe/user/user_directives.md
 | 全局提示词：偏好、语言、编码风格、禁区
 | 你
 | 
| 项目指令
 | .vibe/instructions/project_goals.md、user_directives.md、prd.md
 | 项目目标、项目提示词、产品需求
 | 你
 | 
| 项目记忆
 | .vibe/PROJECT_STATE.md
 | 当前状态与下一步，覆盖写
 | 总 agent
 | 
|  | .vibe/DECISIONS.md
 | 决策与理由，新决定合并或取代旧决定
 | 总 agent
 | 
|  | .vibe/LESSONS.md
 | 踩过的坑与可复用做法
 | 总 agent
 | 
|  | .vibe/INDEX.md
 | 项目文件导航，每个文件一句话
 | 总 agent
 | 
|  | *_ARCHIVE.md
 | 超出上限时降级的旧条目，按需读
 | 自动
 | 
| 执行 agent
 | .vibe/workers/&lt;agent&gt;/MEMORY.md
 | 该 agent 在本项目的经验
 | 该 agent
 | 
| 会话
 | .vibe/sessions/&lt;任务id&gt;.jsonl + .md
 | 消息日志；任务简报、进展、交接摘要
 | daemon；执行 agent
 | 有上限：每个文件按当前模型上下文窗口分配 token 预算，超出时把最久未用的条目降级到 archive（确定性规则，不调用模型）。
带元数据：条目带 id / created / touched / tag，按最近使用去重。
会话结束整理：总 agent 读会话结果写回记忆，并去重、修正矛盾。
派发简报：每次重新生成，指向要读的记忆文件并声明其权威、只读，不粘贴内容。
注入：Claude Code 用 --append-system-prompt；Codex、Kimi、DeepSeek 写 AGENTS.md 中带标记的生成区块；内容按用户指令 → 项目指令 → 记忆 → 本次任务排列，利于前缀缓存。
缓存到期前自动压缩：
daemon 记录每个会话最后一次活动和缓存 TTL。Claude Code 的 statusline 输出有 prompt_cache 的 TTL 与到期时间（订阅主会话通常 1 小时，API key 5 分钟），其他 CLI 在 provider 配置里填。
只按时间触发：本轮结束、会话空闲、距到期不足余量（1 小时 TTL 取 3 分钟，5 分钟 TTL 取 1 分钟）。缓存仍热不压缩，不看上下文大小；卡在权限审批中的会话跳过。
先让 agent 把进展写进会话 .md，再压缩：Claude Code、Codex 发 /compact；不支持的 CLI 改为交接，新会话从记忆文件冷启动。
压缩后注入项目目标和 PROJECT_STATE.md，卡片记一条压缩事件；同一段空闲期只压缩一次。
启动时检测 Claude Code 是否已原生支持空闲压缩（来源），支持则只开原生功能。

### M6 资源调度
采集整机 CPU、内存、磁盘，每个会话的进程树占用，模拟器池与开发板状态，各 provider 剩余额度。
并发上限取全局、单 provider、设备池三者最小。
出队按卡片优先级，同级按进入待办的时间。
某 provider 快耗尽时通知总 agent 改派或等待额度重置。
内存超阈值时暂停出队和模拟器启动，并提示占用最高的会话。
为每个 worktree 的 dev server 分配不冲突端口。

### M7 总览统计

| 指标
 | 计算方式
 | 
| token 分布
 | input / output / 缓存读写，按 agent、模型、项目、日期分组
 | 
| 输出速度
 | 单轮 output tokens ÷ 本轮耗时，取中位数与 P90
 | 
| 估算费用
 | token × 价格表（复用 ccusage 价格数据）
 | 
| 额度窗口
 | providers.listUsage()，显示进度与预计耗尽时间
 | 
| 任务效率
 | 每任务 token、时长、等待你回复的时长、压缩前后 token
 | 
| 资源
 | 运行中会话数、CPU、内存、设备池占用
 | usage indexer 监听各 CLI 日志目录，按文件偏移增量读取，写入 usage_event，并把日志里的 session id 关联到 agent 会话和卡片。

### M8 Android 端
三个主页面：看板、会话汇总、会话详情。
会话汇总页：列出所有进行中的会话；等待你回复的（提问、权限审批）置顶并按等待时长排序，其次是运行中的，最后是刚结束待验证的。
卡片状态：会话的开始、等待回复、出错、切换 agent、压缩、结束都写成卡片事件，卡片角标显示当前状态。
会话详情：回复提问、批准或拒绝操作、发补充指令。
推送：FCM，经自建中继转发；正文只含项目名和事件类型，内容打开后经加密通道拉取。
离线同步规则：

| 数据
 | 手机离线时
 | 同步规则
 | 
| 卡片、标签、评论、草稿
 | 可增删改
 | 双向合并，字段级 LWW（混合逻辑时钟），删除用墓碑
 | 
| 卡片排序
 | 可拖动
 | 分数索引，并发移动不冲突
 | 
| 卡片列
 | 只能在草稿箱与待办之间移动
 | 其余列由 daemon 根据会话事件决定
 | 
| 会话列表、消息、提问
 | 只读，显示“截至 hh:mm”
 | daemon 单向快照 + 增量
 | 
| 提问的回答
 | 可先写好，标记待发送
 | 重连后确认问题仍未回答再发送
 | 
| git 状态、验证证据
 | 只读摘要
 | 单向快照；完整 diff 和证据图在线时按需拉取
 | 实现：用 TinyBase 的 MergeableStore（LWW 型 CRDT + 混合逻辑时钟），手机端 Expo SQLite 持久化，daemon 端 Node SQLite 持久化，在 Paseo 现有加密通道上实现一个 synchronizer。

### M9 连接与中继
配对沿用 Paseo：daemon 生成密钥对，手机扫码获取公钥，之后所有通道共用同一套加密握手。
自动选路：先用 mDNS 找局域网 daemon，再试 Tailscale 地址，都不通走中继。
自建 paseo-relay，同时承担 FCM 推送转发；中继只看到 IP、时间、消息大小和会话 ID（安全文档）。
直连绑定网络地址时必须设置 daemon 密码。

### M10 自动维护
总 agent 按规则自动派子 agent 做项目维护，结果以卡片形式进入看板。触发方式复用 Paseo 自带的 Schedules（按 cron 启动新 agent）和 heartbeat（定时唤醒已有 agent）；“按工作量触发”是 cron 做不到的，由新插件 plugins/vibe-maintain/ 统计工作量后唤醒总 agent。
规则写在 .vibe/maintenance.yml，每条规则包含：触发条件、检查内容、执行 agent（默认由总 agent 选）、产出方式、优先级、去重键、每日上限。

| 触发方式
 | 实现
 | 示例
 | 
| 按工作量
 | 插件监听卡片完成、合并提交数、token 用量，项目累计达到阈值（如完成 10 张卡或合并 30 个提交）时唤醒总 agent
 | git 体检
 | 
| 按时间
 | Paseo Schedules，cron 表达式
 | 每天凌晨读取性能慢记录
 | 
| 按事件
 | 插件监听文件或日志变化
 | 崩溃日志出现新堆栈
 | 两种产出方式，按规则配置：
只提建议：子 agent 只读检查，产出草稿卡片（来源标为“自动维护”），等你和总 agent 讨论后再转入待办。适合整理类工作。
排查并修复：子 agent 在独立 worktree 里排查、修复，卡片直接进入“进行中”，完成后带证据进入“待验证”，由你确认后才合并。适合有明确判据的问题。不会自动合并。
内置两条规则：
git 体检（只提建议，按工作量触发）：检查长期未合并或已合并未删除的分支、遗留 worktree、未提交改动、未推送提交、与主干的冲突、大文件、过期依赖。同类问题合并成一张草稿卡，附检查明细。
性能慢记录（排查并修复，按时间触发）：每个项目在 maintenance.yml 里登记慢记录来源（慢查询日志、APM 导出、基准测试结果、接口耗时日志等）和阈值。子 agent 读取新增慢记录，按调用点去重，与已有卡片比对，对超阈值项先复现、定位、修复，证据包里附修复前后的耗时对比和基准测试结果。修复无把握时降级为草稿卡，写明排查结论。
控制措施：维护卡片默认低优先级，不挤占你的任务；每条规则有每日上限；同一去重键已有未关闭卡片时只追加记录，不重复建卡；连续被你驳回的规则自动暂停并提醒你。

### 数据模型
daemon 用一个 SQLite 文件（~/.vibe/vibe.db）存所有结构化数据；可同步的表进 MergeableStore，只读表由 daemon 单向下发。

| 表
 | 主要字段
 | 同步
 | 
| project
 | id、名称、仓库路径、项目类型、默认预设、并发上限、登记的设备
 | 双向
 | 
| card
 | id、project_id、标题、描述、列、排序键、标签[]、优先级、验收标准、参考图[]、needs_evidence、preset_id、suggested_preset_id、worktree
 | 双向（列受限）
 | 
| card_event
 | id、card_id、类型（评估 / 状态 / 切换 agent / 压缩 / 驳回 / 备注）、作者、正文、时间
 | 双向
 | 
| verification
 | id、card_id、commit 哈希、结论、检查项[]（检查项、证据文件、判断）、验证 agent、时间
 | daemon → 手机
 | 
| preset
 | id、provider、模型、思考强度、权限模式、运行环境
 | 双向
 | 
| agent_session
 | id、card_id、当前 provider、切换历史、状态、waiting_since、待回答内容、cache_expires_at
 | daemon → 手机
 | 
| git_snapshot
 | project_id、分支、ahead/behind、改动文件数、diff 统计、时间
 | daemon → 手机
 | 
| usage_event
 | 时间、provider、模型、session_id、各类 token、耗时、费用
 | 仅电脑；手机拉聚合
 | 
| resource_sample
 | 时间、CPU、内存、每会话占用、设备池状态
 | 仅电脑
 | 补充：card 增加 origin（手动 / 自动维护）、plan_session_id（草稿讨论会话）和方案版本历史；新增 maintenance_rule（规则定义）与 maintenance_run（每次执行的时间、发现、生成的卡片）两张表，双向同步规则、单向下发执行记录。
.vibe/sessions/ 和 .vibe/workers/ 加入 .gitignore；instructions/、prd.md 和记忆文件提交进仓库。仓库根目录的 AGENTS.md 只放一段指引，指向 .vibe/。

## 里程碑
每个阶段过了门槛才进入下一阶段；工期为一人全职粗估。

### P0 Fork 与基础（约 1 周）

| #
 | 任务
 | 验收
 | 
| 1
 | fork 仓库，配置 upstream、CI 与 [core] 提交约定
 | CI 通过；演练合并一次上游 release
 | 
| 2
 | 从源码构建 daemon、桌面端、Android App（debug 签名）
 | 三端在你的电脑和手机上运行
 | 
| 3
 | 自建 paseo-relay（先用临时服务器）
 | 手机经中继配对成功
 | 
| 4
 | 接入四个 agent，关闭其他 provider
 | 四个 agent 都能从手机发起会话
 | 
| 5
 | 引入 Tasks、Switch provider 源码到 plugins/
 | 插件加载，原功能可用
 | 
### P1 看板与验证（约 3 周）

| #
 | 任务
 | 验收
 | 
| 1
 | 五栏、总看板 tab 与项目 tab
 | 卡片可在五栏间流转，按项目筛选
 | 
| 2
 | 执行 agent 预设字段、标签、优先级
 | 派发时按预设启动会话
 | 
| 3
 | 卡片事件流，与会话状态联动
 | 会话状态变化实时出现在卡片上
 | 
| 4
 | 验证勾选、检查项、证据包数据结构与展示
 | 卡片末尾显示逐条证据
 | 
| 5
 | Android 模拟器取证：AVD 快照、Maestro / adb、截图与录屏
 | 一个 Android 任务产出完整证据包
 | 
| 6
 | Web 与后端取证
 | 一个 Web 任务、一个后端任务产出证据包
 | 
| 7
 | 独立验证 agent 与失败自动退回
 | 故意做错的任务被退回并附失败证据
 | 
### P2 总 agent 与上下文（约 2–3 周）

| #
 | 任务
 | 验收
 | 
| 1
 | 记忆文件读写、上限与降级
 | 超上限时旧条目进入 archive
 | 
| 2
 | 上下文注入：--append-system-prompt 与 AGENTS.md 生成区块
 | 四个 agent 上场即知项目状态
 | 
| 3
 | 总 agent 插件 + skill：唤醒、草稿评估、推荐
 | 新草稿 1 分钟内出现评估评论
 | 
| 4
 | 子 agent 选择、优先级出队、资源监控
 | 额度紧张时高优先级先执行
 | 
| 5
 | 总 agent 订阅手动切换（桌面与手机）
 | 切换后继续处理同一批卡片
 | 
| 6
 | 缓存到期前自动压缩
 | 空闲会话在到期前压缩，卡片有记录
 | 
| 7
 | 草稿讨论会话：每卡一个规划会话、方案写回卡片、版本历史、转入待办时生成交接摘要
 | 与总 agent 讨论 3 轮后转入待办，执行 agent 按最终方案开工
 | 
| 8
 | 自动维护框架：maintenance.yml、工作量计数、接入 Paseo Schedules、去重与上限；内置 git 体检规则
 | 完成 10 张卡后自动出现一张 git 整理草稿卡
 | 
### P3 Android 离线与扩展（约 3–4 周）

| #
 | 任务
 | 验收
 | 
| 1
 | packages/app 本地 SQLite + MergeableStore
 | 飞行模式下可编辑看板
 | 
| 2
 | packages/server synchronizer
 | 离线改 20 张卡，重连后零丢失
 | 
| 3
 | 会话汇总页、等待回复置顶、卡片状态角标
 | 等待中的会话始终在最上方
 | 
| 4
 | FCM 推送经自建中继
 | 提问与待验证事件推送到手机
 | 
| 5
 | usage indexer 与总览页
 | 统计与 ccusage 对账一致
 | 
| 6
 | iOS 模拟器、桌面应用、固件仿真、硬件在环取证
 | 一个硬件任务带上板证据
 | 
| 7
 | 性能慢记录规则：登记慢记录来源、排查并修复、前后耗时对比证据
 | 一条人为制造的慢查询被自动修复并带对比证据进入待验证
 | 
## 风险

| 风险
 | 应对
 | 
| 合并上游冲突
 | 自研尽量放 plugins/；核心改动小而独立、带 [core] 前缀；每两周合并一次，不积压
 | 
| 引入的社区代码缺维护
 | Tasks、Switch provider 已并入自己仓库，带回归测试
 | 
| 离线同步出错
 | 同步层单独做模糊测试：随机断网、并发编辑、时钟漂移
 | 
| 验证证据不可信
 | 验证与实现分离、验证 agent 只读；证据带 commit 哈希；存疑项交给你
 | 
| 硬件取证覆盖不全
 | 仿真结果标注“未上板”；关键检查项要求硬件在环；无法自动判断的标为存疑
 | 
| 模拟器与开发板占用
 | AVD 快照启动；设备池排队；只对勾选验证证据的卡片取证
 | 
| 会话格式转换丢细节
 | 项目记忆兜底；切换时记录切换前的会话摘要
 | 
| 总 agent 额度耗尽
 | 推送提醒你手动切换；卡片排队，不降级到弱模型做管理决策
 | 
| CLI 日志格式变化
 | 解析器按版本适配，跟随 ccusage 更新
 | 
| 安全
 | 配对二维码等同密码；直连必须设密码；总 agent 不直接改代码；烧录需预先授权
 | 
## 开工前待确认
硬件项目常用的芯片平台和开发板（如 ESP32、STM32、nRF），决定 P3 先接哪套仿真器和烧录工具。
有没有 Mac 主机？iOS 模拟器取证只能在 macOS 上跑。
P1 用哪 1–2 个项目做验证证据的首批试点。

## Sources
Paseo 仓库 · Paseo 安全文档 · paseo-relay
Tasks 插件 · Switch provider 插件 · Deepseek Harness 插件
Kimi Code CLI：在 IDE / Paseo 中使用
Orbital 仓库 · Orbital 使用教程
ccusage · TinyBase MergeableStore
claude-console v0.16.0 发布说明（Claude Code 空闲压缩）
