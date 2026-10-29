# vibe-scheduler

第五轮的 workspace/task 资源调度。生产运行器只扫描已确认的 queued task；WP-114 已删除旧卡片调度、推荐排序与失效设置，设备和资源入口继续服务原生任务。

- 调度器独立按用户显式队列顺序、confirmedAt FIFO 准入，不询问总 bot。每次实际准入仍重新检查确认快照和资源。总 bot 只可读取状态、按用户要求调整队列。
- 主代理、子代理及辅助角色共用全局/provider/原生项目并发。主代理空闲且原生 activeTurn 已结束后可 yield 让出计算名额与写锁；重新工作须再次 acquire，支持并发 1 的顺序委派。
- Git common-dir 的真实路径决定仓库身份；规范化 files/globs 决定写锁。未知范围、目录外路径或无法保守判断的 glob 按仓库排他。同一 worktree 的主子代理也不能重叠写入。
- verifier 在验证期间持有整个仓库的写屏障；设备由实际 evidence collector 租用，避免重复申请同一设备。其它执行角色的设备租约按 workspace 保留，父代理 yield 后子代理可顺序借用；存在活跃借用者时父代理不能恢复。
- 停止状态不明时保留文件锁、并发名额、设备和端口；设备不因 TTL 自动释放。重启先冻结资源、核对原生状态，不重发历史执行请求。
- 端口与资源租约分别写入 VIBE_HOME/scheduler/ports.json 和 task-resources.json（原子替换）。后者只保存调度资源所有权，不保存任务运行历史或消息。损坏文件时停止新派发。在线调整端口范围只影响之后的新分配。

## 编排接口

总线 scheduler.task_resource_request 与 RPC scheduler.task_resource 共用输入：

- acquire：requestId、workspaceId、role，以及可选 subtaskId、candidateIndex。worker/subagent/reviewer/verifier 只能使用确认时冻结的模型与文件范围；子任务自定义 presetId 必须读取 rolesSnapshot.subtaskPresets 中对应子任务的冻结快照，缺失时拒绝，不能读实时预设或静默用默认；planner/scout/plan_reviewer 在规划期可给 provider/model/presetId 申请辅助资源。master 独立给实际 provider/model。
- bind：requestId、workspaceId、reservationId、agentId。先创建空闲原生 agent，再绑定；workspace、真实目录、provider 和显式模型须与准入一致，成功后才允许运行。相同角色资源不能被第二个 acquire 当作新会话复用；并行辅助会话用不同 subtaskId 作资源身份。
- yield/release：requestId、workspaceId、reservationId。服务端查询原生状态，idle/closed/error 且无 activeTurn 才能让出/释放；未知不等于停止。
- freeze：先撤销排队并暂停新派发，保留所有资源。
- reconcile：主动核对停止状态；未绑定且原生 workspace 全部 agent 空闲的租约可安全回收，创建失败后无需改 task 阶段即可尝试下一候选。恢复或停止形成的冻结会话不会自动续发。

响应事件 scheduler.task_resource_result 含 requestId/workspaceId/ok/reason/retryable 与可选 reservationId/presetId/provider/model/port/deviceIds。retryable=true 是资源争用，应等待后用新 requestId 重试；无效快照、错误模型或原生状态不明应停下报告。申请超时结果不明时不能直接创建会话，先 reconcile。

scheduler.queue.order 接收 workspaceIds 和 reason，只调整已确认等待任务的优先顺序，空列表恢复 FIFO；顺序与理由保存在 vibe_meta。总 bot 的 vibe_scheduler_read 与 vibe_queue_reorder 使用相同调度服务，并由 vibe-bots 登记的活跃总 bot 主对话授权。调度器直接执行规则，不发送总 bot 排序事件。实际准入发布 scheduler.task_admitted（含 workspaceId/confirmedAt/reservationId/model/port/devices），由任务流程 owner 创建主代理。

完成后的记忆/需求文件整理可用 master + hostLease:true + files 申请插件文件操作写锁；文件范围按项目主检出与任务同一真实仓库核对。该操作不冒充原生 anchor，不需要 bind，插件 await 文件写入完成后 release。重启后仍须核对停止状态再回收。

scheduler.task_tick 是隔离验收的显式 tick 入口。scheduler.status 返回当前租约、并发计数、排队原因、额度与设备池；资源采样继续记录 CPU/内存和各原生 agent 工作目录下的进程占用。

## 宿主边界

宿主任务会话在投递前调用编排准入，受管成员所有回合先获得资源；agent.turn_started 的检查继续作为异常运行的停止兜底。规划权限按实际模型配置与文件范围决定，不把提示词当作严格只读。资源停止结果不明时保留租约；本插件没有修改 packages/。

## 检查

在本目录运行 npm test 和 npm run typecheck。真实机器资源采样测试需显式设置 VIBE_E2E_SAMPLE=1。真实模型与隔离 daemon 的联调证据由 WP-112 总报告记录；单元测试中的原生状态与设备争用是合成夹具。
