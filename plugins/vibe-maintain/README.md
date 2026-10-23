# vibe-maintain

维护规则一次定义，选择适用项目或全部项目；项目的 `.vibe/maintenance.yml` 仅覆盖该项目。规则、运行记录、每日上限、暂停和增量游标仍按规则 × 项目保留，移出作用域只停用记录。

所有 `output: suggest` / `output: fix` 都创建新的原生 Git worktree、workspace 和只读规划 anchor，发送中文首消息，等待用户显式 `/执行`。不创建旧卡片、不预授权、不直接修复。项目必须已关联原生项目且能创建独立 worktree；失败会保留运行诊断与发现，不在项目原目录执行。

```yaml
rules:
  - name: git-health
    trigger: { kind: workload, cards_done: 10, commits_merged: 30 }
    check: { type: git, outdated: false }
    agent: null
    output: suggest
    daily_cap: 1
```

`agent` 可指定预设 ID、名称或 provider/model；未指定使用维护默认模型。规划强制只读，不使用执行预设的写入权限。Codex 使用原生 provider options 的 sandbox_mode=read-only、approval_policy=never，不传不存在的 read-only modeId；Claude 使用 plan 模式。规划也先向调度器申请并绑定资源，原生 turn 结束后请求释放；调度器确认 idle 后才真正回收。调度器不可用或并发已满时保留任务及失败原因。

同规则、同项目已有未完成任务时只补充新发现，不因新调用点另建 workspace。已确认或运行的任务先经 WP-111 Stop 协调；停止不确定则暂停派发、冻结并保留原租约与确认，将新增发现写入摘要，禁止改方案或按旧文件范围继续执行。停止成功后通过任务命令清除旧确认和角色快照，重新规划并等待 `/执行`。

触发方式保留工作量、cron 和新增文件内容。历史键 `cards_done` / `<ruleId>:cards` 继续存储，含义改为完成任务轮次；完成幂等按 workspace + confirmedAt，摘要更新与事件重放不重复累计。token 来自 `usage_event.project_id`，不再关联旧 card。每日上限按 UTC 统计；手动运行忽略门槛、暂停和上限，但依然计入运行次数。

归档未完成维护 workspace 视为驳回，同一任务仅计一次；连续达到阈值自动暂停。成功完成或手动恢复清除连续驳回数，普通确认和摘要事件不清零。设置页显示每项目进度、当日次数、上次结果、失败原因与配置错误；旧规则 screen 留到 WP-114 统一删除。

性能规则 `check.type: perf-slow` 增量读取 JSONL、benchmark JSON、MySQL/PostgreSQL 日志，按调用点聚合。确认前不执行配置的 `repro` 命令；规划包含复现、最小修复和 `.vibe/verify.json` 的 `backend.perf` 配置。用户确认后，执行 agent 将配置纳入提交，vibe-verify 的任务 pipeline 创建基线 worktree，backend collector 分别运行基线和修复后的命令并生成 `perf-compare.json`。没有可靠基线或提升不足时保留 doubt，不假报通过。没有复现配置时先在规划中确定度量方法。

共享写入集中在新增 `createMaintenanceCommands`；
`maintenance_task` 保留原生任务去重与发现，`maintenance_run.workspace_ids_json` 保存运行关联。旧规则、计数、旧 `card_ids_json` 历史不丢。

运行相关测试与类型检查：

```powershell
npm test -- test/engine.test.ts test/launch.test.ts test/rules.test.ts test/perf-slow.test.ts test/client-format.test.ts test/behaviour.test.ts
npm run typecheck
```

性能集成测试从规划消息提取配置，使用真实 Node 命令测量合成 baseline/after，覆盖 collector 接口；它不代替完整任务生命周期、真实模型、设备与 Git 收尾的隔离 daemon 验收。测试仓库基线复用当前 HEAD 的 sparse clone，不为夹具新建提交。
