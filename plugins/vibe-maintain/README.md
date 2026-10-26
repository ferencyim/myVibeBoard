# vibe-maintain

维护规则一次定义，选择适用项目或全部项目；项目的 `.vibe/maintenance.yml` 仅覆盖该项目。规则、运行记录、每日上限、暂停和增量游标仍按规则 × 项目保留，移出作用域只停用记录。

所有 `output: suggest` / `output: fix` 都创建新的原生 Git worktree、workspace 和规划 anchor，发送中文首消息，等待用户显式 `/执行`。不创建旧卡片、不预授权、不直接修复。项目必须已关联原生项目且能创建独立 worktree；失败会保留运行诊断与发现，不在项目原目录执行。

```yaml
rules:
  - name: git-health
    trigger: { kind: workload, cards_done: 10, commits_merged: 30 }
    check: { type: git, outdated: false }
    agent: null
    output: suggest
    daily_cap: 1
```

Git 体检按分支/worktree 生成逐对象台账：同一分支的 worktree 并入一行，detached worktree 和主工作区单独一行；每行带目录是否存在、最近提交、领先/落后主干、是否已合并、上游与未推送、未提交改动、合并冲突和 locked。检查按固定规则给出「可清理 / 建议合并 / 需你决定 / 保留」，默认 7 天活动窗口（`cleanup_after_days` 可调）；大文件与过期依赖是附加小节。「需你决定」按原因分组（locked、有未提交改动、会冲突、未推送、detached、仅因活动窗口的未合并或已合并干净对象等），一个对象有多个原因时归入风险最高的组，组内按最近提交时间排序；台账带「原因/建议」列，其后各节只列每组数量、一句建议和对象名。任务正文是可直接拍板的 Markdown 方案，不再附整段发现 JSON（自定义模板仍可用 `{{findings_json}}`）。检查与现场核实都用 `GIT_OPTIONAL_LOCKS=0`，不 fetch、不改仓库状态。

`agent` 可指定预设 ID、名称或 provider/model；未指定使用维护默认模型。规划按普通规划 tab 的 provider 默认模式启动，不再强制只读；提示词要求规划阶段只用只读命令核实台账、不改文件与 git 状态。规划先向调度器申请并绑定资源，原生 turn 结束后请求释放；调度器确认 idle 后才真正回收。调度器不可用或并发已满时保留任务及失败原因。

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
