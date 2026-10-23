# vibe-scheduler

第五轮的 workspace/task 资源调度。生产运行器只扫描已确认的 queued task；旧 card 调度函数及其测试保留到 WP-114，生产 tick 不再调用。

- 默认由总 agent 给已确认候选排序；开关关闭、不可用或超时按 confirmedAt FIFO。每次实际准入仍重新检查确认快照和资源。
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

排队事件为 scheduler.task_dispatch_wanted {requestId,workspaceIds,slots}；总 agent 回 master.task_dispatch_chosen {requestId,workspaceIds,reason} 或 master.task_dispatch_failed。实际准入发布 scheduler.task_admitted（含 workspaceId/confirmedAt/reservationId/model/port/devices），由任务流程 owner 创建主代理。

完成后的记忆/需求文件整理可用 master + hostLease:true + files 申请插件文件操作写锁；文件范围按项目主检出与任务同一真实仓库核对。该操作不冒充原生 anchor，不需要 bind，插件 await 文件写入完成后 release。重启后仍须核对停止状态再回收。

scheduler.task_tick 是隔离验收的显式 tick 入口。scheduler.status 返回当前租约、并发计数、排队原因、额度与设备池；资源采样继续记录 CPU/内存和各原生 agent 工作目录下的进程占用。

## 宿主边界

宿主当前没有原生 turn/send 前的插件守卫，已经打开的 tab 可直接开始新回合。本插件在 agent.turn_started 检测未登记/已 yield 的执行回合后冻结并请求 cancel；这属于事后检测，不能保证抢先写工具绝不发生。原生 auto 规划按可能写入的仓库排他范围计数，不把提示词当作严格只读。WP-111 必须保证辅助角色实际只读、禁止未登记写工具/子代理，并补齐需要的回合前准入边界；本插件没有修改 packages/。

## 检查

在本目录运行 npm test 和 npm run typecheck。真实机器资源采样测试需显式设置 VIBE_E2E_SAMPLE=1。真实模型与隔离 daemon 的联调证据由 WP-112 总报告记录；单元测试中的原生状态与设备争用是合成夹具。
