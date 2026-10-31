# vibe-board

原生任务流程插件。保留 `vibe-board` 插件身份；旧看板、卡片 CRUD、同步 RPC、MCP 和 CLI 已删除。

任务在原生 workspace 中使用固定的 #1–#6 流程 tab 和任务面板。流程档位决定默认启用的角色、方案确认与验证路径；通过只接受当前有效验证提交，安全合并并 push 后保留 workspace 和 worktree。

侧栏「Agent 行为」配置提示词；设置页「任务角色」配置全局任务角色及方案审阅者超时，项目设置可覆盖角色配置；项目扩展自动关联原生项目。宿主负责会话公开历史、成员投递、审批、Stop、窄屏面板及独立首消息 outbox。调度、证据、上下文、维护、统计由对应插件协作。

共享业务数据在 `$VIBE_HOME/vibe.db`，所有写入经 vibe-shared 命令层。WP-114 首次升级先一致性备份并检查，再删除旧表；旧卡与旧手机积压不导入。

宿主项目列表在插件内共用单飞及成功后 30 秒缓存；文档保持 15 秒对账并复用本轮项目快照。占位 tab 使用独立的 `vibe.task.tabs.resolve` 数据库投影，不触发预建、宿主刷新或其它任务方案扫描。预建不可恢复失败在当前插件运行期停止重试，插件重载后重新校验；暂时失败按 1–30 分钟退避，错误日志最多每 5 分钟一次且不带堆栈。

每个项目 bot 首次打开立即显示创建中，侧栏对应行每秒轮询并在后台完成后自动打开；失败显示中文原因，可重试。同一 bot 创建单飞，不同 bot 独立创建。默认模型回退只读取宿主现有缓存，不在打开路径探测全部 provider 或等待模型刷新；缓存尚无可用模型时，请先在「任务角色」设置具体模型。

## 开发

侧栏请求控制与展示状态的测试直接使用组件共用的纯逻辑，不挂载 React 组件。插件单独安装的 React 与根目录 React DOM/Testing Library 可能解析到不同副本；保留创建轮询、失败重试和迟到导航保护的行为断言。

```sh
npm ci
npm run typecheck
npm test
```

SDK 依赖 `file:../../packages/plugin`，必须在本仓库内安装。`shared/vibe`、`server/vibe`、`client/vibe` 是声明式共享副本，修改源 `plugins/vibe-shared` 后在仓库根运行 `npm run vibe:sync-shared`，再运行 `npm run vibe:sync-shared:check`。不要手改副本。

流程档位、授权、验证和未启用 tab 的规则见 [第十轮设计 2.5 节](../../docs/vibe/ROUND10-DESIGN.md#25-流程档位第十轮第-6-条)。简单档由宿主在写屏障下运行 #4 提供的自测命令并记录输出；流程面板读取或验收时检查证据是否因代码变化而作废。用户在执行 tab 发的原生消息仍是执行授权并经过调度准入；agent 互发消息不算授权。

设计见 [ROUND5-DESIGN.md](../../docs/vibe/ROUND5-DESIGN.md) 与 [ROUND6-DESIGN.md](../../docs/vibe/ROUND6-DESIGN.md)，操作见 [USER-GUIDE.md](../../docs/vibe/USER-GUIDE.md)。上游来源及许可证见 [UPSTREAM.md](UPSTREAM.md) 和 LICENSE。
