# vibe-master

总 agent 只为已确认任务排序，并在完成后整理项目记忆与需求文档。方案问答、执行、复核、验证和用户验收属于原生 workspace 的对应角色。

- 调度器发布 `scheduler.task_dispatch_wanted {requestId,slots,workspaceIds}`，总 agent 回复 `master.task_dispatch_chosen` 或 `master.task_dispatch_failed`。派发默认开启；关闭、不可用、超时或格式错误由调度器按确认时间 FIFO。回复只建议顺序，最终准入、文件锁与设备租约始终归调度器。
- `task.updated` 的完成状态触发整理；启动补扫所有尚未整理的完成任务。模型只看 task 的方案、子任务结果和摘要，不读取旧卡片。结果追加到 `task.summary`，原生流程 owner 统一将摘要投递到 anchor。
- 模型调用在原生 agent 创建后、回合开始前申请并绑定计算租约。完成整理的文件写入另申请任务仓库的 `.vibe/**` 与需求文件锁，等待文件锁时不保留模型计算租约。租约释放须由调度器确认原生已停止；请求超时会冻结并核对，不能静默放行。
- 完成整理的已校验 JSON 与阶段持久化在 `<VIBE_HOME>/master/state.json`。文件锁忙时保留 pending 结果并定时重试，重启复用结果；已完成的整理按 workspace 与确认时间去重。需求文档仍只提交该文件，绝不 push；截断的摘录和关闭的维护开关都不会重写需求文档。
- 总 agent 使用预设的有序候选；实际模型、思考档和候选序号记入会话。失败、额度耗尽与不可用切换候选；上下文冷交接使用同一候选。旧原生会话保留可打开，交接只用 task 快照和持久化摘要，旧会话的 provider 不被重写。

提示词统一注册：`master.task_dispatch`、`master.wake.task_done`、系统规则、JSON 修复与交接提示均支持既有全局/项目覆盖。规则单一来源为 `skills/vibe-master/SKILL.md`，修改后运行 `npm run gen:rules`。

RPC 保留状态、权限和会话历史入口；新手动整理入口为 `master.task.wake {workspaceId,force=false}`。旧卡片 UI、合同和历史组件保留到 WP-114，旧卡片 wake 返回入口停用，旧卡片事件不再自动触发运行，旧规划运行器不随总 agent 启动。

相关验证：在插件目录运行 `npm run typecheck`、`npm test -- test/task-runtime.test.ts test/master-resources.test.ts`。原生 anchor 的完整 timeline 展示、执行到验收和 Git 收尾由 WP-111 接入，隔离 daemon 联调需同时加载调度器与共享合同最新副本。
