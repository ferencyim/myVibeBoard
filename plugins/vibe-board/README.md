# vibe-board

原生任务流程插件。保留 `vibe-board` 插件身份；旧看板、卡片 CRUD、同步 RPC、MCP 和 CLI 已删除。

在同一个原生任务会话中提供七角色接手者、任务面板与 slash 操作：制定方案、方案复核、执行、代码复核、验证、通过。执行只接受用户显式确认的最新完整方案，通过只接受当前验证提交；安全合并并 push 后保留 workspace 和 worktree。

侧栏「Agent 行为」配置提示词；设置页「任务设置」配置项目扩展、模型预设、全局/项目默认和需求文档。宿主负责会话公开历史、成员投递、审批、Stop、窄屏面板及独立首消息 outbox。调度、证据、上下文、维护、统计由对应插件协作。

共享业务数据在 `$VIBE_HOME/vibe.db`，所有写入经 vibe-shared 命令层。WP-114 首次升级先一致性备份并检查，再删除旧表；旧卡与旧手机积压不导入。

## 开发

```sh
npm ci
npm run typecheck
npm test
```

SDK 依赖 `file:../../packages/plugin`，必须在本仓库内安装。`shared/vibe`、`server/vibe`、`client/vibe` 是声明式共享副本，修改源 `plugins/vibe-shared` 后在仓库根运行 `npm run vibe:sync-shared`，再运行 `npm run vibe:sync-shared:check`。不要手改副本。

第六、七轮起任务流程是 workspace 里的编号 tab：新建任务即预建探路、执行、复核、验证 tab（空闲不耗 token），另有轻量「任务流程」面板。用户在执行 tab 发的原生消息本身就是执行授权，仍要过调度准入：有完整方案就确认该方案，没有方案时这条消息就是任务说明；执行中追问不重复准入；agent 互发消息不算授权。完整语义见 [ROUND6-DESIGN.md](../../docs/vibe/ROUND6-DESIGN.md) 第 8 节。

设计见 [ROUND5-DESIGN.md](../../docs/vibe/ROUND5-DESIGN.md) 与 [ROUND6-DESIGN.md](../../docs/vibe/ROUND6-DESIGN.md)，操作见 [USER-GUIDE.md](../../docs/vibe/USER-GUIDE.md)。上游来源及许可证见 [UPSTREAM.md](UPSTREAM.md) 和 LICENSE。
