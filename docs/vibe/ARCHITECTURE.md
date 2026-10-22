# myVibeBoard 技术设计（可派工版）

> 状态：设计稿 v1（基于 paseo 0.12.0，分支 `arch/design`）。读者是后续并行实现 P1/P2/P3 的子代理。
> 上游需求见 [PRODUCT-REQUIREMENTS.md](../../PRODUCT-REQUIREMENTS.md)，完整方案见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)，
> 构建见 [BUILD.md](BUILD.md)，fork 约定见 [FORK-WORKFLOW.md](FORK-WORKFLOW.md)。
> 公开仓库：本文及所有后续文档、脚本、配置**不得出现主机 IP、用户名、域名、密钥**，一律用 `<MAC_HOST>`、`<RELAY_HOST>`、`<RELAY_DOMAIN>` 等占位符。

## 0. 关键结论

1. **插件的客户端 UI 能在 Android App 上显示。** 客户端插件 bundle 由 daemon 编译后经 `getPluginCatalog()` 下发，App 在 JS 运行时（Hermes）里 `eval` 执行，
   screen/侧栏/面板/composer 等贡献点都用 React Native 组件渲染，`layout.platform` 明确包含 `android`。限制：**只在连着 daemon 时可用**（断线即 `removeHost`），
   所以 P3 的“飞行模式可编辑看板”必须靠 [core] 改动（见 §3.7）。Hermes `eval` 与 Windows 上实机渲染未亲测，由 WP-02 在模拟器验证。
2. **P1/P2 全部可写成插件，不改 `packages/`。** 插件拥有：服务端生命周期钩子、RPC、`agent.create` 前置钩子（注入 systemPrompt/MCP/env）、本机 `node:sqlite`、`PaseoApi`（建 worktree/agent、列用量）。
3. **插件之间不能互调 RPC**（`PaseoApi` 没有 `invokePluginRpc`），也不能 import 插件目录外的源码（编译器判为 `invalid`）。设计：**共享 SQLite（`vibe.db`）+ 事件表 `vibe_event` 当总线 + 单一来源包 `plugins/vibe-shared` 经脚本同步副本**。
4. **P3 只需极少量 [core]**：App 离线（本地库、RPC 拦截、插件 bundle 离线保留）、推送（网关 + 最小化正文 + 原生 FCM token）、可选的直连密码强制。**服务端同步不需要改 `packages/server`**——用插件 RPC 当传输（`DaemonClient.invokePluginRpc` 已存在，走现成加密通道）。
5. Paseo 已有：Expo 推送（`exp.host`）、App 只读离线副本（目录+时间线，expo-sqlite）、多连接探测选路。会话汇总页大半可复用。
6. 本次设计相对原方案的**偏差**（均有理由，见 §9）：不用 TinyBase，改自研“字段级 LWW + HLC + 墓碑”；推送网关做成独立小服务而非改 Elixir 中继；硬件取证推迟。

---

## 1. Paseo 扩展机制：事实依据

### 1.1 插件 API（`packages/plugin/src`）

| 能力             | 位置 / API                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 清单             | 插件目录 `paseo-plugin.json`（`id`、`requirements.paseo`、可选 `build` argv 数组）；说明 `docs/plugins.md`                                                                                                                                                                                                                                                                                     |
| 目录约束         | 仅 `index.client.tsx`/`index.server.ts` + `client/` `server/` `shared/`；跨目录或根目录其它代码的相对 import 编译报错（`packages/server/src/server/plugins/compiler.ts` `directoryTarget`）。**插件目录外的源文件一律 `invalid`**，只有“包名匹配的 npm 依赖”例外                                                                                                                               |
| 服务端入口       | `PluginServerContext`（`server/contracts.ts`）：`handle(rpc, handler)`、`on(event, cb)`、`before(name, cb)`、`registerSettings`、`registerProvider`、`registerUsageSource`                                                                                                                                                                                                                     |
| 生命周期事件     | `server/lifecycle.ts`：`agent.created/closed/archived/turn_started/turn_ended/permission_requested/permission_resolved`、`workspace.created/archived`。`turn_ended` 带 `outcome`（completed/failed/canceled）与完整 `timeline`                                                                                                                                                                 |
| 前置钩子         | `agent.create`（可改 `systemPrompt`、`mcpServers`、`toolPolicy`、`modeId`、`env`，不能改 `cwd`）、`agent.session_open`（只能改 `env`）、`workspace.create`（可改整个创建请求）。超时 30s                                                                                                                                                                                                       |
| 钩子注意         | 观察者回调里**不要 await 会反向调用 agent 变更的操作**（会死锁）；事件“实时、尽力而为”，不回放不重试——所以我们用 `vibe_event` 表自己做持久化                                                                                                                                                                                                                                                   |
| RPC              | `shared/` 里 `defineRpc({name,input,output})`（`rpc.ts`，zod 双端校验）；服务端 `server.handle`，客户端 `useRpc` / `client.rpc`；线上走 `plugin.rpc.invoke.request`（`packages/protocol/src/messages.ts`）                                                                                                                                                                                     |
| 服务端 SDK       | `handler` 的 `{ paseo }`：`PaseoApi`（`packages/client/src/index.ts` L486）= `workspaces`（含 worktree 创建）、`projects`、`agents`（`create({parent,labels,env,config,prompt})`、`ref(id).send/run/respondToPermission/commands/timeline.append`）、`terminals`、`providers`（`listUsage()`、`listModels` 等）、`config`、`observeEvents`。**没有 schedules/heartbeat、没有 invokePluginRpc** |
| 客户端贡献点     | `client/contracts.ts` `PluginClientContext`：`addScreen`、`addSidebarHeaderItem/FooterItem`、`addWorkspacePanel`（workspace/agent 上下文，可进 explorer）、`addCommandCenterItem`、`addSlashCommand`、`addHeaderButton`、`addComposerPill`、`addAttachmentSource`、`addSettingsScreen`、`addTimelineTransformer/Renderer`、`addTheme`、`openScreen/openPanel`                                  |
| 客户端数据       | `useRpc`、`usePaseo`、host 提供的 `@tanstack/react-query`（每插件独立 QueryClient）、`PluginScreenProps{theme,host,layout{compact,platform},params,navigation}`。**无实时推送通道**：Tasks 用 `refetchInterval` 3–5s 轮询（`plugins/vibe-board/client/screen.tsx` L129–180）                                                                                                                   |
| 可用模块         | 客户端只能 import：`react`、`react-native`、`zod`、`@tanstack/react-query`、`@getpaseo/plugin/*`（`app/src/plugins/evaluate.ts`）。不能用 `expo-sqlite`、`lucide-react-native`、DOM                                                                                                                                                                                                            |
| 内置 vs 目录插件 | 内置列表 `packages/server/src/server/plugins/builtin/index.ts`（改它是 [core]）；我们走**目录插件**：`paseo plugin install <dir>`，需 `pluginsEnabled: true`。同目录可再装多次                                                                                                                                                                                                                 |
| 示例             | `plugin-examples/lifecycle-actions`（自动回答权限、发后续提示、选 worktree）、`provider-*`、`timeline-items`                                                                                                                                                                                                                                                                                   |

### 1.2 插件 UI 在 Android 的渲染链路（结论：能）

- `packages/app` 是同一份 Expo 代码跑 Android/Web/Electron。插件路由：`app/src/app/h/[serverId]/plugin/[pluginId]/[contributionKind]/[contributionId].tsx`、`.../[surfaceId].tsx`、设置页 `settings/hosts/[serverId]/plugins/[pluginId]/[screenId].tsx`。
- 目录加载：`app/src/plugins/catalog-sync.tsx` 在已连接且 host 支持 `plugins` feature 时 `client.getPluginCatalog()` → `plugins/registry.ts` `installCatalog` → `plugins/evaluate.ts` `runPluginClientBundle`（`globalThis.eval(bundle)`，注入 host 的 React/RN/zod/react-query）。
- 平台字段：`plugins/platform.ts` 返回 `ios|android|web`；公开文档 `public-docs/plugins/reference.md`“Cross-platform rules”明确“Client code runs on iOS, Android, and in browsers”，并有 modal/sheet/键盘的 Android 适配。
- 限制与风险：
  1. **断线即卸载**：`catalog-sync.tsx` 在 `!connected` 时 `pluginRegistry.removeHost(serverId)`；bundle 不持久化。→ 离线看板需 [core]。
  2. 插件 RPC 是请求/响应，无服务端推送。→ 轮询 + 版本号（沿用 Tasks 的 `task_list_revision` 思路）。
  3. Hermes 对 `eval` 的支持、大 bundle 首屏性能未实测。→ **WP-02** 在已有的 Android 模拟器上装 debug APK 验证 Tasks 原样插件（见 BUILD.md §3）。
  4. 移动端无拖拽：Tasks 看板靠“Move to”菜单（`detail-view.tsx` L828）；我们沿用，compact 下列用横向分页。

### 1.3 daemon 能力

| 主题                  | 事实 / 位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 对设计的意义                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话生命周期          | §1.1 事件；`agent.permission_requested` 的 `request.kind` 含 `question`；快照字段 `attentionReason`(finished/error/permission)、`attentionTimestamp`、`pendingPermissions`、`lastUsage`、`contextWindowUsedTokens`（`protocol/src/messages.ts` L838、`agent-types.ts`）；`protocol/src/agent-state-bucket.ts` `deriveAgentStateBucket` 已有 needs_input>failed>running>attention>done 排序                                                                                    | 卡片事件、“等待回复置顶”直接复用                                                                                                                  |
| 编排                  | `PaseoApi.workspaces.create({source:{kind:"worktree",action:"branch-off",baseBranch,worktreeSlug}})` + `workspace.agents.create(...)`；`agents.create({parent})` 建子 agent；Tasks `domain.ts` `delegate()` L1285 已是完整范例（预设→worktree→agent→timeline 卡片）                                                                                                                                                                                                           | 派发直接改造 `delegate()`                                                                                                                         |
| MCP                   | daemon MCP（`server/agent/mcp-server.ts`、`tools/paseo-tools.ts`）提供 create_agent、send_agent_prompt、create_schedule、create_heartbeat、list_providers、respond_to_permission 等；注入开关 `daemon.mcp.injectIntoAgents`。看板 MCP 是 Tasks 自带的“本机回环 HTTP + stdio MCP 脚本”（`server/bridge.ts`），经 `agent.create` 钩子注入                                                                                                                                       | 总 agent 用 daemon MCP 管子 agent + 看板 MCP 读写卡片                                                                                             |
| Schedules / heartbeat | 服务 `server/schedule/service.ts`（cron、tick 1s）；仅在 MCP 工具与 CLI 暴露（`create_schedule`/`create_heartbeat`），`PaseoApi` 不含                                                                                                                                                                                                                                                                                                                                         | M10 的“按时间”：由 vibe-maintain **自带 setInterval cron**（简单、可测），不依赖 Paseo Schedules；用户若想要可见的 schedule，总 agent 可经 MCP 建 |
| 用量                  | `PaseoApi.providers.listUsage()` → `usage.list_reports`；用量源插件 `registerUsageSource`（仓库已有各 `*-usage-source`）                                                                                                                                                                                                                                                                                                                                                      | M4/M6/M7 额度窗口                                                                                                                                 |
| 加密通道 / 中继       | `packages/relay`（`encrypted-channel.ts`、`crypto.ts` 为 E2EE 握手；`cloudflare-adapter.ts` 为 CF 版）；**官方中继是独立 Elixir 仓库 getpaseo/paseo-relay**（`public-docs/security.md`、`docs/docker.md`）；daemon 配置 `daemon.relay.{enabled,endpoint,publicEndpoint,useTls}`（`server/config.ts` L302–326）                                                                                                                                                                | 中继用官方镜像自建，不改它；我们不新增中继协议                                                                                                    |
| 多连接选路            | `app/src/runtime/host-runtime.ts`：一个 host 可有多条 connection，周期探测选最优                                                                                                                                                                                                                                                                                                                                                                                              | M9“局域网/Tailscale/中继自动选”基本已有；mDNS 没有（`rg mdns` 无命中），默认**不做 mDNS**，用户手填 LAN/Tailscale 地址为额外 connection           |
| 推送                  | `server/push/{index,push-service,token-store}.ts`：**已有 Expo 推送**（`https://exp.host/--/api/v2/push/send`），token 经 `register_push_token` 存 `push-tokens.json`；`createPushNotifications({deliver})` 可注入投递函数；触发在 `websocket-server.ts` L2627/L2725（`agent-attention-policy.ts` 决定是否推）；App 端 `app/src/push-notifications/internal/subscriptions.ts` 用 `getExpoPushTokenAsync`，`app.config.js` 引用 `google-services.json`（密钥文件，**不入库**） | “提问/待验证推送”本来就有（permission/finished）；缺的是：自建网关、正文最小化（现在 body 含助手消息预览）                                        |
| 离线副本              | `app/src/runtime/replica-cache/*`（expo-sqlite，`docs/data-model.md`“Replica row store”，32MiB）、`runtime/directory-sync`；只读 agent/workspace/project/timeline                                                                                                                                                                                                                                                                                                             | 会话列表/消息“截至 hh:mm”只读已具备；我们只需补**看板数据**                                                                                       |
| 密码                  | `daemon.auth.password`/`PASEO_PASSWORD`；核心**不强制**非回环绑定必须设密码                                                                                                                                                                                                                                                                                                                                                                                                   | [core] 小改（WP-48）                                                                                                                              |
| 文件/浏览器           | 内置浏览器工具 `public-docs/browser*.md`；`docs/development.md` 的 Playwright MCP                                                                                                                                                                                                                                                                                                                                                                                             | Web 取证                                                                                                                                          |

### 1.4 本机工具现状（影响验收写法）

`adb` 在 PATH；Android SDK 有 `emulator`（未入 PATH，`%LOCALAPPDATA%\Android\Sdk\emulator`）；**没有** maestro、docker、qemu、renode、probe-rs、openocd、playwright。
→ 所有外部工具都封装在“可注入的 Runner”后面，单测用假 Runner；真机/模拟器集成测试用环境变量显式开启（如 `VIBE_E2E_ANDROID=1`），默认跳过。中继/推送在本机用**本地进程**测试（无 docker）。

---

## 2. vibe-board（Tasks 插件）现状与改造

### 2.1 现状（`plugins/vibe-board`，来自 anh-chu/paseo-plugin-tasks，Apache-2.0，见 `UPSTREAM.md`）

- 独立 npm 项目（自带 node_modules 与 lockfile），已在根 `tsconfig/oxlint/oxfmt/knip` 排除。`paseo-plugin.json` id 仍是 `tasks`（**改造要改成 `vibe-board`**，否则与用户已装的旧 tasks 冲突）。
- 服务端：`node:sqlite`（`server/sqlite.ts`，WAL + busy_timeout，数据目录 `$PASEO_HOME/plugin-data/tasks/tasks.db`）、迁移 `server/schema.ts`、数据访问 `server/store.ts`(1961 行)、业务 `server/domain.ts`(1949 行，含 `delegate`、`registerLifecycleHooks`)、回环 HTTP + stdio MCP `server/bridge.ts`、CLI `server/cli-runner.ts`+`bin/paseo-tasks.mjs`、附件 `server/attachments.ts`。
- 共享：`shared/contract.ts`（45 个 `tasks.*` RPC，ULID id）、`shared/constants.ts`（状态/优先级/预设枚举）、`shared/directive.ts`（`::task{key=}` 时间线卡片）。
- 客户端：`client/screen.tsx`(看板/列表，compact 已适配)、`detail-view.tsx`、`modals.tsx`、`badges.tsx`、`timeline-card.tsx`。
- 测试：`test/tasks.test.ts`（含委派与 bridge 的 mock 测试）。

### 2.2 映射到方案数据模型

| Tasks                                                            | 方案                                                                                 | 改造                                                                                                                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`(prefix 如 PROD、`linked_bb_project_id`)               | `project`                                                                            | 保留 prefix（卡片键 `ABC-12` 便于 agent 引用）；加 `repo_path`、`project_type`、`default_preset_id`、`concurrency_limit`、`devices`。`linked_bb_project_id` 改名 `paseo_project_id` |
| `folders`                                                        | —                                                                                    | 删除（UI 与表）                                                                                                                                                                     |
| `tasks.status`(backlog/todo/in_progress/in_review/done/canceled) | `card.column`                                                                        | 改为 `draft/todo/in_progress/verifying/done`；`canceled` 用 `archived_at`；子任务保留为“拆分子卡”                                                                                   |
| `tasks.priority`                                                 | `card.priority`                                                                      | 保留                                                                                                                                                                                |
| `labels`/`task_labels`                                           | 标签                                                                                 | 改为全局固定词表（bug/feature/change 默认，refactor/test/doc/research 预置），多选；标签决定默认验证策略                                                                            |
| `presets`                                                        | `preset`                                                                             | 已含 provider/model/reasoning/permission/environment_kind/base_branch：补 `runtime_env`（运行环境）；`instructions` 保留                                                            |
| `task_threads`                                                   | `agent_session`                                                                      | 加 `current_provider`、`switch_history`、`waiting_since`、`pending_question`、`cache_expires_at`、`role`                                                                            |
| `comments`(user/agent/system)                                    | `card_event`                                                                         | 扩展 `type`：evaluation/status/switch_agent/compaction/reject/note/maintenance；`kind`→`author_kind`                                                                                |
| `attachments`                                                    | 参考图 / 证据文件                                                                    | 保留 blob 机制；证据另走 `verification` 表（文件落盘）                                                                                                                              |
| `delegate()`                                                     | 派发                                                                                 | 改造为 WP-12 的 `dispatchCard()`，加入口径：只允许从 `todo` 派发、调度器放行、写 `agent_session`                                                                                    |
| 无                                                               | `verification`、`maintenance_*`、`usage_event`、`resource_sample`、`plan_version` 等 | 新增，归属见 §4                                                                                                                                                                     |

---

## 3. 总体设计

### 3.1 目录布局与所有权

```
plugins/
  vibe-shared/        # 非插件：单一来源包（契约、DB、迁移、状态机、事件总线、同步算法）
    contract/         #   纯 TS + zod，运行时中立（客户端/服务端/App 都能用）
    db/               #   node:sqlite 封装、迁移框架、命令层、事件总线（仅服务端）
    sync/             #   HLC、字段级 LWW 合并、分数索引、墓碑、变更流（纯 TS，两端共用）
  vibe-board/         # 看板：UI + 卡片 RPC/MCP/CLI + 派发 + 生命周期联动 + 同步端点 + 回复队列端点
  vibe-verify/        # 验证流水线 + 采集器（web/backend/android/ios/desktop）
  vibe-master/        # 总 agent（记忆整理、订阅切换）+ 卡片规划会话（planning，用卡片上的规划模型，WP-105）
  vibe-context/       # 记忆文件、注入、会话 .md、缓存到期前压缩
  vibe-scheduler/     # 资源监控、出队、设备池、端口、子 agent 选择
  vibe-stats/         # 用量索引与总览页
  vibe-maintain/      # maintenance.yml、工作量计数、规则执行
  switch-provider/ deepseek-harness/   # 已有，不动
skills/vibe-master/   # 总 agent 的 skill
services/vibe-push-gateway/  # P3：独立小服务（推送网关）
deploy/relay/         # P3：中继部署脚本（仅入库，不执行）
packages/app/src/vibe/        # [core] P3：App 离线与同步客户端、会话汇总页扩展
scripts/vibe/         # 同步脚本、本地 e2e 辅助、部署检查
```

### 3.2 单一来源与分发：`plugins/vibe-shared`

- 数据表定义、zod 契约、状态机、枚举**只写一次**在 `plugins/vibe-shared/contract` 与 `db`。
- 因编译器禁止 import 插件目录外源码，用 `scripts/vibe/sync-shared.mjs`（WP-00）把它们**复制**到：
  - 各插件 `plugins/<p>/shared/vibe/`（contract+sync，客户端可用）与 `plugins/<p>/server/vibe/`（db，仅服务端）；
  - `packages/app/src/vibe/generated/`（contract+sync，供 App 离线）。
  - 副本带 `// GENERATED FROM plugins/vibe-shared — DO NOT EDIT` 头并**入库**；`node scripts/vibe/sync-shared.mjs --check` 必须在每个 WP 的测试里通过（副本漂移则失败）。
- **已选定：复制方案。** WP-00 的 spike（[SPIKE-SHARED.md](SPIKE-SHARED.md)）证明编译器会放行 `file:` 依赖（`findDependencyRoot` 例外），技术上可行；但 App 仍需要副本、且 `file:` 要求 vibe-shared 单独安装依赖，所以不采用。
- 同步脚本用法（`npm run vibe:sync-shared` / `vibe:sync-shared:check`）：
  - 消费者在自己的 `package.json` 声明 `"vibe": { "shared": { "shared": ["contract","sync"], "server": ["db"] } }`：`shared` 列出的子目录复制到 `plugins/<p>/shared/vibe/<子目录>`，`server` 列出的复制到 `plugins/<p>/server/vibe/<子目录>`。`packages/app/src/vibe/` 目录一旦存在（WP-40），`contract`+`sync` 自动同步到 `packages/app/src/vibe/generated/`。
  - 副本目录（`shared/vibe`、`server/vibe`、`generated`）是**纯生成目录**：里面的非副本文件视为漂移，写模式下会被删除，插件自己的代码不要放进去。
  - 不复制 `*.test.*`、`__tests__`、`node_modules`；`.ts/.js/.sql` 等加头注释，换行统一为 LF，`--check` 对 CRLF 检出不误报。
  - 没有任何消费者时 `--check` 直接通过；声明了却缺源目录则报错（退出码 2）。
- 新建插件一律用 `npm run vibe:new-plugin -- <name> [--client]`（生成 `plugins/vibe-<name>/`：manifest 已声明本仓库的 Paseo 版本范围、`package.json` 含 `typecheck`/`test`、tsconfig、vitest 配置、空入口、manifest 兼容性测试）。随后在该目录 `npm install` 生成并提交 `package-lock.json`。合并上游 release 后跑 `npm run vibe:check-plugins` 核对所有 vibe 插件的 `requirements.paseo`。
- 开发 daemon：`pwsh scripts/vibe/dev-daemon.ps1 -Plugin plugins/vibe-board`（隔离 `PASEO_HOME`/`VIBE_HOME`，默认端口 16767，需已 `build:server`，`-Stop` 停止，`-Reload` 重载）。注意：Paseo 默认关闭插件，脚本在隔离 home 的 `config.json` 里写了 `pluginsEnabled: true`。

### 3.3 存储与迁移

- 一个 SQLite 文件：`$VIBE_HOME/vibe.db`，`VIBE_HOME` 默认 `~/.vibe`（与方案一致），**测试与开发 daemon 必须设置 `VIBE_HOME` 到临时目录**，防止污染正式库。WAL + `busy_timeout=5000`，多个插件子进程可同时打开。
- 迁移框架（`vibe-shared/db/migrate.ts`）：`schema_version(owner, version, applied_at)`。每张表有唯一 owner 插件，**只有 owner 做 DDL**；其他插件只读或经命令层写：

| owner                                                                   | 表                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vibe-board（由 vibe-shared 迁移 `core` 命名空间，首个启动者执行，幂等） | `project`, `card`, `card_event`, `preset`, `tag`, `card_tag`, `attachment`, `agent_session`, `plan_version`, `vibe_event`, `sync_meta`, `sync_tombstone` |
| vibe-verify                                                             | `verification`, `verification_item`, `evidence_file`                                                                                                     |
| vibe-context                                                            | `memory_entry`（元数据索引；文件本体在 `.vibe/`）                                                                                                        |
| vibe-scheduler                                                          | `resource_sample`, `device`, `device_lease`                                                                                                              |
| vibe-stats                                                              | `usage_event`, `usage_cursor`                                                                                                                            |
| vibe-maintain                                                           | `maintenance_rule`, `maintenance_run`, `work_counter`                                                                                                    |

- 迁移的版本号以 `vibe-shared` 为准（WP-01 产出），Tasks 旧库**不迁移**（新库新结构）。

### 3.4 插件间通信

1. **数据**：共享 `vibe.db`。所有对 `card`/`card_event`/`agent_session` 的写入必须走 `vibe-shared/db/commands.ts` 的命令函数（执行状态机校验、盖 HLC 时间戳、写 `vibe_event`），禁止裸 SQL 写这些表。
2. **事件**：`vibe_event(seq AUTOINCREMENT, ts, type, card_id, project_id, payload_json)` 是持久化事件总线。订阅方各自保存游标（`sync_meta` 的 `cursor:<plugin>`），用 `PRAGMA data_version` 判断有无变化后拉取，间隔 500ms。事件类型（WP-01 在 `contract/events.ts` 定死）：`card.created/updated/moved`、`card.assessed`、`card.dispatched`、`session.started/waiting/answered/ended/error/switched/compacted`、`verification.started/finished`、`maintenance.triggered`、`plan.updated`、`scheduler.admitted/dispatch_failed/quota_low/paused/resumed`（WP-34 追加）、`master.alert`（WP-50 追加，总 agent 的提醒，取代原先 `session.error` + `[master:…]` 前缀）。

   **启动即可用的句柄与推送（WP-50，[core]）**：`PluginServerContext` 新增 `paseo`（contribute 时即可用，无需等钩子/RPC，无头 daemon 也能派发）和 `notify({title, body, data, agentAttention})`（经 daemon 推送服务发送；最小正文模式下 daemon 截断标题/正文、只保留短字符串 `data`）。推送消费者在 `plugins/vibe-master/server/notify/`，订阅 `card.moved→verifying`（"Ready to verify"）、worker 的 `session.waiting`（"Needs your answer"）、`master.alert`；标题=项目名，正文=事件类型，data 只带卡片编号。**去重**：Paseo 自己对 agent 的 permission/finished/error 已推送；`session.waiting` 带 `agentAttention={agentId, reason:"permission"}`，daemon 在 2 分钟内处理过同一 agent 同一 reason 的注意事件就不再推（含因用户正在看而有意不推的情形）。`card.moved→verifying` 不去重——它与 Paseo 的 "Finished" 是不同语义，可能同时到达两条。

3. **指令**：需要“让别人做事”时写事件或卡片事件（如「制定方案」写一条 `chat{thread:"plan",action:"make_plan"}` → vibe-master 的规划器轮询到后开始规划；`card.moved→done` → 总 agent 整理记忆）。不做插件间 RPC。
4. **agent 通道**：看板 MCP（回环 HTTP + stdio，沿用 Tasks bridge，工具名改 `vibe_*`）。角色标记通过 `agent.create` 的 `request.env`（`VIBE_ROLE=master|planner|worker|verifier`、`VIBE_CARD_ID`）和 `labels`；MCP 按角色裁剪工具集（verifier 无写代码类、worker 无评估类）。
5. **UI 通道**：客户端 UI 只经 vibe-board 的 RPC 读数据；其他插件的客户端贡献（stats 页、master 设置）读自家 RPC。

### 3.5 看板状态机（`vibe-shared/contract/state-machine.ts`）

```
draft ──(用户)──▶ todo ──(调度器放行→dispatch)──▶ in_progress ──(会话结束)──▶ verifying ──(用户通过)──▶ done
  ▲                 ▲                                   ▲                         │
  └─(用户退回)──────┘                                   └─(检查项失败/用户驳回)───┘
```

| 迁移                  | 触发者                                        | 条件                                                                                                     |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| draft↔todo            | 仅用户（App 离线可做）                        | 「立即执行」先由用户把草稿移到待办；模型不得移动                                                         |
| todo→in_progress      | vibe-board dispatch（受 vibe-scheduler 放行） | 创建 worktree+会话成功                                                                                   |
| in_progress→verifying | vibe-board lifecycle                          | **默认**：执行 agent 一轮 `completed` 结束且无待答问题；若用户随后给该会话发消息，卡片自动回 in_progress |
| verifying→in_progress | vibe-verify（检查项失败）或用户驳回           | 失败证据作为下一轮提示发给**原会话**                                                                     |
| verifying→done        | 仅用户“通过”                                  | 然后合并/开 PR、清理 worktree、总 agent 写记忆                                                           |

状态机是纯函数，WP-01 提供穷举单测；非法迁移在命令层抛错。

### 3.6 执行流程（P1 主线）

`dispatchCard(cardId)`（WP-12）：读卡片+预设→`paseo.workspaces.create`(worktree branch-off，slug=`<key>-<title>`)→`workspace.agents.create`（prompt 为派发简报，env 含 `VIBE_ROLE=worker`、`VIBE_CARD_ID`，labels 含 `cardKey`）→写 `agent_session`、`card_event`、`vibe_event`。
生命周期联动（WP-12，替换 Tasks 的 `registerLifecycleHooks`）：`agent.turn_started/ended`、`permission_requested/resolved`（question→`waiting`，写 `waiting_since`）、`agent.closed/archived`、失败→`error`。
验证（WP-20）：订阅 `card.moved(to=verifying)`；若 `needs_evidence` 才取证，否则只跑测试和 lint；验证 agent 由 `dispatch` 同样机制创建（`VIBE_ROLE=verifier`），**只读强制**：① 用 `agent.permission_requested` 钩子自动拒绝写文件类请求；② 验证前后各取 `git status --porcelain` + HEAD，不一致则证据作废并标“验证者改动了代码”；③ MCP 无写代码工具。

### 3.7 离线与同步（P3）

**设计原则**：同一份看板 UI（plugin 客户端代码）在线/离线都能跑；离线靠 [core] 让 App 本地提供同一份 RPC。

1. **服务端同步端点（不改 core）**：`plugins/vibe-board/server/sync/` 提供 RPC `vibe.sync.exchange({deviceId, since, changes[]}) → {changes[], cursor}`。服务端对可同步表保存 `(table,row_id,column,value,hlc)`，用 `vibe-shared/sync` 合并：字段级 LWW、HLC 比较、删除=墓碑、卡片排序用分数索引（字符串 fractional index，并发移动不冲突）、卡片列受限（离线仅 draft↔todo；其余列的变更在服务端被拒绝并回传权威值）。daemon→手机的只读表（`agent_session`、`verification` 摘要、`git_snapshot`）走同一接口的“快照+增量”。
2. **App 本地库与引擎（[core]，WP-40）**：`packages/app/src/vibe/`：expo-sqlite 独立库 `vibe-local.db`，同步引擎调用 `client.invokePluginRpc("vibe-board","vibe.sync.exchange",…)`（已在 `packages/client/src/daemon-client.ts` L5703），重连/前台/每 10s 触发。
3. **RPC 拦截（[core]，WP-40）**：`app/src/plugins/registry.ts` 的 `invoke` 是单一咽喉点；对 `vibe-board` 的“看板数据类”RPC 改由本地实现应答（`vibe.cards.list/update/move/create`…，契约来自 `vibe-shared` 的生成副本），写入打 HLC 并标 dirty；在线时同步引擎后台对账。这样插件 UI 代码零改动。
4. **插件 bundle 离线保留（[core]，WP-40）**：`catalog-sync.tsx` 在断线时不 `removeHost`，改为从本地持久化的目录缓存恢复已评估的安装（缓存 bundle+hash，存 replica 库旁的新表）；断线时 `usePaseo()` 相关调用失败，由插件自行降级（vibe-board UI 只依赖 RPC）。路由 `h/[serverId]/plugin/...` 在 host 离线时需放行（`HostRouteBootstrapBoundary` 现状需 WP-02 确认）。
5. **回复队列（WP-43）**：离线写好的回答存本地 `pending_reply(card, question_id, text)`；重连后先 RPC `vibe.reply.check` 确认该提问仍 pending 再发送（`respondToPermission`），否则标“已失效”。
6. **兜底**：若 WP-02 发现路由/离线保留改动过大，降级方案是 App 原生页面（`packages/app/src/vibe/screens`，复用同一本地库），UI 重写一份。**默认不走此方案。**

### 3.8 推送（P3，WP-44）

- 沿用 Paseo 既有触发（`agent-attention-policy.ts`：permission/finished/error），不新增触发点。
- [core] 小改：`daemon.push.gateway`（URL，可选）配置存在时，`createPushNotifications` 的 `deliver` 改为 POST 到网关；并新增 `daemon.push.minimalPayload`（默认 true）：正文只含“项目名 + 事件类型”，不含助手消息预览。App 端改用原生设备 token（`Notifications.getDevicePushTokenAsync()`，FCM）并随 `register_push_token` 带 `kind:"fcm"`。
- `services/vibe-push-gateway/`（Node，无框架）：`POST /v1/push {token,title,body,data}` → FCM HTTP v1。服务账号 JSON 只从环境变量/文件路径读取，**不入库**；`--dry-run` 与可注入的 FCM 端点用于测试。部署与中继同机，见 §7。
- `google-services.json` 与 FCM 服务账号：由用户在本机/服务器放置，仓库只有示例文件名与说明。

---

## 4. 数据模型（单一来源：`plugins/vibe-shared/contract/model.ts` + `db/migrations/*.sql`）

主键 ULID（沿用 Tasks）；时间 ISO-8601 UTC。可同步表每行有 `updated_hlc`，字段级时间戳在 `sync_meta(table,row_id,column,hlc,device)`。

| 表                                 | 关键字段（在方案基础上的补充）                                                                                                                                                                                                                                                 | 同步                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| project                            | id, name, prefix, repo_path, project_type, default_preset_id, concurrency_limit, devices_json, paseo_project_id, color                                                                                                                                                         | 双向                   |
| card                               | id, project_id, number, key, title, description, column, sort_key(分数索引), priority, acceptance, ref_images_json, needs_evidence, preset_id, suggested_preset_id, worktree, origin(manual/maintenance), plan_session_id, parent_card_id, archived_at, created_at, updated_at | 双向（column 受限）    |
| card_event                         | id, card_id, type, author_kind(user/agent/system), author, body_json, created_at                                                                                                                                                                                               | 双向                   |
| plan_version                       | id, card_id, version, snapshot_json（描述/检查项/子卡/标签/推荐 agent）, created_at                                                                                                                                                                                            | daemon→手机            |
| preset                             | id, name, provider, model, thinking, permission_mode, environment_kind, base_branch, runtime_env, instructions, builtin                                                                                                                                                        | 双向                   |
| tag / card_tag                     | 固定词表                                                                                                                                                                                                                                                                       | 双向                   |
| agent_session                      | id, card_id, agent_id(Paseo), role, current_provider, switch_history_json, state(starting/working/waiting/idle/ended/error), waiting_since, pending_question_json, cache_expires_at, last_activity_at                                                                          | daemon→手机            |
| verification                       | id, card_id, commit_hash, conclusion(pass/doubt/fail), verifier_agent_id, mode(evidence/tests_only), started_at, finished_at                                                                                                                                                   | daemon→手机            |
| verification_item                  | id, verification_id, check_text, method, judgement(pass/doubt/fail), note, evidence_ids_json                                                                                                                                                                                   | daemon→手机            |
| evidence_file                      | id, verification_id, item_id, kind(screenshot/gif/video/log/report/photo), path, thumb_path, sha256, captured_at, commit_hash, simulated(bool)                                                                                                                                 | 元数据下发，文件按需拉 |
| git_snapshot                       | project_id, branch, ahead, behind, dirty_files, diff_stat, taken_at                                                                                                                                                                                                            | daemon→手机            |
| usage_event                        | ts, provider, model, session_id, tokens(in/out/cache_r/cache_w), duration_ms, cost, card_id                                                                                                                                                                                    | 仅电脑（手机拉聚合）   |
| resource_sample                    | ts, cpu, mem, per_session_json, device_pool_json                                                                                                                                                                                                                               | 仅电脑                 |
| device / device_lease              | 模拟器/开发板/调试器登记与独占租约                                                                                                                                                                                                                                             | 仅电脑                 |
| maintenance_rule / maintenance_run | 规则定义（双向）/ 执行记录（daemon→手机）：trigger, dedupe_key, daily_cap, output_mode, findings, card_ids                                                                                                                                                                     | 见左                   |
| vibe_event                         | 事件总线（§3.4）                                                                                                                                                                                                                                                               | 仅电脑                 |
| sync_meta / sync_tombstone         | HLC 元数据与墓碑                                                                                                                                                                                                                                                               | 内部                   |

文件系统：`<repo>/.vibe/{instructions,PROJECT_STATE.md,DECISIONS.md,LESSONS.md,INDEX.md,*_ARCHIVE.md,workers/<agent>/MEMORY.md,sessions/<cardId>.{jsonl,md},maintenance.yml}` 与 `~/.vibe/user/user_directives.md`（见方案 M5）；`sessions/`、`workers/` 入 `.gitignore`。证据文件：`$VIBE_HOME/evidence/<verificationId>/…`。

---

## 5. 方案任务 → 落点映射

标 [core] 的必须改 `packages/`（单独提交，信息前缀 `[core]`）。

| 方案任务                                | 落点                                                                                 | WP                   |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------- |
| P1#1 五栏/总看板 tab/项目 tab           | vibe-board 客户端 `client/board/*`；`index.client.tsx`                               | WP-11                |
| P1#2 预设、标签、优先级、派发按预设     | vibe-board 客户端 `client/presets/*` + 服务端 dispatch                               | WP-14, WP-12         |
| P1#3 卡片事件流联动                     | vibe-board `server/lifecycle/*` + 事件总线                                           | WP-12                |
| P1#4 验证勾选/检查项/证据包             | 数据 vibe-verify；展示 vibe-board `client/verification/*`                            | WP-20, WP-21         |
| P1#5 Android 模拟器取证                 | vibe-verify `server/collectors/android/*`                                            | WP-23                |
| P1#6 Web 与后端取证                     | vibe-verify `server/collectors/{web,backend}/*`                                      | WP-22                |
| P1#7 独立验证 agent 与失败退回          | vibe-verify `server/verifier/*`                                                      | WP-20                |
| P2#1 记忆文件、上限、降级               | vibe-context `server/memory/*`                                                       | WP-30                |
| P2#2 上下文注入                         | vibe-context `server/inject/*`                                                       | WP-31                |
| P2#3 总 agent 唤醒/评估/推荐            | vibe-master + skills/vibe-master                                                     | WP-32                |
| P2#4 子 agent 选择/出队/资源监控        | vibe-scheduler                                                                       | WP-34                |
| P2#5 总 agent 订阅手动切换（桌面+手机） | vibe-master `settings` + RPC + 命令面板 + 看板 header 按钮（手机即插件 UI）          | WP-32                |
| P2#6 缓存到期前压缩                     | vibe-context `server/compaction/*`                                                   | WP-35                |
| P2#7 草稿讨论会话                       | vibe-master `server/planning/*` + vibe-board `client/planning/*`                     | WP-33                |
| P2#8 自动维护框架+git 体检              | vibe-maintain                                                                        | WP-36                |
| P3#1 App 本地库+离线                    | [core] `packages/app/src/vibe/*`、`plugins/registry.ts`、`plugins/catalog-sync.tsx`  | WP-40                |
| P3#2 同步                               | 服务端为插件 RPC（vibe-board `server/sync/*`），**不改 packages/server**             | WP-41（+WP-13 算法） |
| P3#3 会话汇总页/角标                    | [core] `packages/app/src/vibe/sessions/*` + 路由；角标为 vibe-board 客户端           | WP-42                |
| P3#4 推送                               | [core] `server/push/*`、`app/src/push-notifications/*`、`services/vibe-push-gateway` | WP-44                |
| P3#5 usage indexer 与总览页             | vibe-stats                                                                           | WP-45                |
| P3#6 取证扩展                           | **只做 iOS（远程 macOS 执行器）与桌面应用**；固件仿真/硬件在环**推迟**               | WP-46                |
| P3#7 性能慢记录规则                     | vibe-maintain `rules/perf-slow/*`                                                    | WP-47                |
| M9 连接与中继                           | 部署脚本 `deploy/relay/*`；[core] 可选密码强制                                       | WP-48                |

---

## 6. [core] 改动清单（全部小而独立）

| #   | 文件                                                                                                                | 内容                                                                | WP          |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| C1  | `packages/app/src/plugins/registry.ts`                                                                              | `invoke` 咽喉点增加“本地 RPC 提供者”钩子（按 pluginId+method 注册） | WP-40       |
| C2  | `packages/app/src/plugins/catalog-sync.tsx` + 新增缓存存储                                                          | 断线保留插件安装、持久化 bundle                                     | WP-40       |
| C3  | `packages/app/src/vibe/**`（新增目录）                                                                              | 本地库、同步引擎、本地 RPC、会话汇总页                              | WP-40/42/43 |
| C4  | `packages/app/src/app/**` 路由                                                                                      | 汇总页入口、离线时放行插件路由                                      | WP-40/42    |
| C5  | `packages/server/src/server/push/*`、`websocket-server.ts`(取 gateway 配置)、`persisted-config.ts`(`daemon.push.*`) | 网关投递 + 最小正文                                                 | WP-44       |
| C6  | `packages/app/src/push-notifications/internal/subscriptions.ts`                                                     | 原生 FCM token                                                      | WP-44       |
| C7  | `packages/server/src/server/config.ts` / `bootstrap.ts`                                                             | 非回环绑定未设密码则拒绝启动（可用环境变量显式放行）                | WP-48       |

仓库级配置（`tsconfig.json`/`plugins/tsconfig.json`/`.oxlintrc.json`/`.oxfmtrc.json`/`knip.json` 的排除项加入 `plugins/vibe-*`、`services/**`）由 WP-00 一次性完成，避免多 WP 冲突。

---

## 7. 工作包（WP）清单

执行约定：每个 WP 一个分支/worktree（`D:\devRepoCaches\worktrees\myVibeBoard-<wp>`），只改自己“拥有的目录”；跨目录需求先改本文档再派工。完成标准 = 验收命令全部通过 + `node scripts/vibe/sync-shared.mjs --check` 通过。插件包验收命令统一为 `cd plugins/<p> && npm ci && npm run typecheck && npm test`。难度：简/中/难（建议模型：简→Haiku 级，中→Sonnet 级，难→Opus 级）。

### 批次 0（可并行，无依赖）

| WP    | 名称                                                            | 拥有                                                                                                                  | 依赖 | 难度 |
| ----- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| WP-00 | 仓库脚手架、同步脚本、本地 e2e 辅助                             | `scripts/vibe/**`；根配置排除项；各新插件骨架（空 `paseo-plugin.json`+`package.json`+tsconfig+vitest 配置，不含业务） | —    | 中   |
| WP-01 | **vibe-shared：契约+DB+迁移+状态机+事件总线+命令层+采集器接口** | `plugins/vibe-shared/{contract,db}/**`                                                                                | —    | 难   |
| WP-02 | Android 插件 UI 验证 spike                                      | `docs/vibe/SPIKE-ANDROID.md`（仅文档，不改代码）                                                                      | —    | 中   |

- WP-00 验收：`sync-shared.mjs` 把 `vibe-shared` 复制到示例插件并 `--check` 通过；spike 结论已写入 `docs/vibe/SPIKE-SHARED.md`（可行但不采用，附复现命令）；`scripts/vibe/dev-daemon.ps1` 以隔离的 `PASEO_HOME`/`VIBE_HOME` 启动 daemon 并 `paseo plugin install` 一个插件目录。
- WP-01 验收：`npm test` 覆盖——迁移幂等与多 owner 并发打开；状态机穷举（合法/非法迁移）；命令层写入产生 `vibe_event` 与 HLC；事件总线游标；契约 zod 往返；`EvidenceCollector`/`Runner` 接口类型（供 WP-22/23/46）。
- WP-02 验收：文档记录：装 Tasks 原样插件→在模拟器（`adb devices` 中的 emulator）打开 screen 的截图、`eval` 是否可用、断线后插件 UI 行为、`h/[serverId]/plugin/...` 路由在 host 离线时是否可达、轮询 RPC 耗时；结论决定 §3.7 走 3 还是 6。

### 批次 1（P1 看板与派发；依赖批次 0）

| WP    | 名称                                                                 | 拥有                                                                                                                                                              | 依赖                    | 难度 |
| ----- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---- |
| WP-10 | vibe-board 服务端改造（store/RPC/MCP/CLI/附件）                      | `plugins/vibe-board/{server/store,server/rpc,server/mcp,server/cli,server/attachments,shared/rpc}/**`、`index.server.ts`、`paseo-plugin.json`(id 改 `vibe-board`) | WP-00,01                | 难   |
| WP-11 | vibe-board 客户端：五栏看板、总看板/项目 tab、卡片详情、compact 适配 | `plugins/vibe-board/client/{board,detail,common}/**`、`index.client.tsx`                                                                                          | WP-01,10(契约可先 mock) | 难   |
| WP-12 | 派发与生命周期联动                                                   | `plugins/vibe-board/server/{dispatch,lifecycle}/**`                                                                                                               | WP-01,10                | 难   |
| WP-13 | 同步算法库（HLC、字段 LWW、分数索引、墓碑、变更流）+ 模糊测试        | `plugins/vibe-shared/sync/**`                                                                                                                                     | WP-01(表描述类型)       | 难   |
| WP-14 | 预设/标签/优先级选择器与 agent 额度显示                              | `plugins/vibe-board/client/presets/**`                                                                                                                            | WP-01,10                | 中   |

- WP-10 验收：`tasks.test.ts` 改造为 `board.test.ts`：五栏 CRUD、排序、过滤、标签词表、预设；MCP 工具（`vibe_list/show/create/update/comment/attach`）经 bridge 的 HTTP 测试；写入全部走命令层且产生 `vibe_event`；旧 `folders` 与 `tasks.*` RPC 名全部移除（`rg "tasks\\."` 无残留）。
- WP-11 验收：组件测试（vitest + react-test-renderer，若无则纯逻辑测试 + 截图脚本）；在 dev daemon + Web 与 **Android 模拟器**各截一张五栏图；compact 下列分页、Move-to 菜单可用；轮询版本号变化才刷新。
- WP-12 验收：mock `PaseoApi` 测试：todo→dispatch 创建 worktree+会话；`turn_ended` 完成→`verifying`；question→`waiting`+`waiting_since`；失败→error；用户续聊→回 `in_progress`；`vibe_event` 序列正确。
- WP-13 验收：属性/模糊测试——随机断网、并发编辑、时钟漂移（±1h）、重复投递，任意交换顺序后两副本收敛；20 张卡离线改动合并零丢失；墓碑不复活；分数索引并发插入有序且不冲突。
- WP-14 验收：选择器按 `providers.listUsage()`（mock）显示剩余额度；预设持久化往返。

### 批次 2（P1 验证；依赖批次 1 的 WP-10/12）

| WP    | 名称                                                                         | 拥有                                                                                         | 依赖        | 难度 |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------- | ---- |
| WP-20 | vibe-verify 核心：证据包、验证 agent、只读强制、失败退回                     | `plugins/vibe-verify/{index.server.ts,server/{pipeline,verifier,store,rpc}}/**`、`shared/**` | WP-01,10,12 | 难   |
| WP-21 | 卡片“验证结果”区块 UI（结论、检查项、证据缩略图、通过/驳回）                 | `plugins/vibe-board/client/verification/**`                                                  | WP-20 契约  | 中   |
| WP-22 | Web 与后端采集器                                                             | `plugins/vibe-verify/server/collectors/{web,backend}/**`                                     | WP-01(接口) | 中   |
| WP-23 | Android 模拟器采集器（AVD 快照、adb、可选 Maestro、截图/录屏转 GIF、logcat） | `plugins/vibe-verify/server/collectors/android/**`                                           | WP-01(接口) | 难   |

- WP-20 验收：假采集器+mock PaseoApi 的流水线测试：检查项全过→verification=pass；任一失败→卡片回 `in_progress` 且失败证据进入原会话提示；`needs_evidence=false` 只跑测试/lint；验证者改动代码被检测为作废；证据带 commit 哈希与时间；“故意做错的任务被退回”用端到端 mock 脚本复现。
- WP-22 验收：Runner 假实现的单测；在本仓库自身做真集成（`VIBE_E2E_WEB=1`）：起 dev web 抓桌面/手机宽度截图与控制台错误；后端跑本仓库某包测试并生成请求/响应样例。
- WP-23 验收：命令构造与输出解析的单测（假 `adb`）；`VIBE_E2E_ANDROID=1` 时在本机模拟器装 debug APK（见 BUILD.md）取截图/录屏/logcat 崩溃检查，产出完整证据包；Maestro 不在 PATH 时降级 adb 并在证据注明；设备经 `device_lease` 独占。
- WP-21 验收：列表/缩略图懒加载（缩略图 RPC 返回 base64，原图按需）；Android 模拟器截图。

### 批次 3（P2；WP-30 仅依赖 WP-01，可提前到批次 1 并行）

| WP    | 名称                                                                                | 拥有                                                                                                 | 依赖     | 难度 |
| ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- | ---- |
| WP-30 | 记忆文件读写、token 上限、确定性降级归档、条目元数据                                | `plugins/vibe-context/server/memory/**`                                                              | WP-01    | 中   |
| WP-31 | 上下文注入与派发简报                                                                | `plugins/vibe-context/server/inject/**`                                                              | WP-30,12 | 中   |
| WP-32 | 总 agent：唤醒/防抖、评估 JSON→评论、MCP 工具、skill、订阅切换                      | `plugins/vibe-master/{index.*,server/{wake,assess,subscription},client/**}`、`skills/vibe-master/**` | WP-10,31 | 难   |
| WP-33 | 草稿讨论会话：每卡规划会话、只读子 agent、方案写回+版本、交接摘要                   | `plugins/vibe-master/server/planning/**`、`plugins/vibe-board/client/planning/**`                    | WP-32,10 | 难   |
| WP-34 | vibe-scheduler：资源采样、并发上限、优先级出队、设备池、端口分配、子 agent 选择     | `plugins/vibe-scheduler/**`                                                                          | WP-01,12 | 难   |
| WP-35 | 缓存到期前自动压缩                                                                  | `plugins/vibe-context/server/compaction/**`                                                          | WP-30,31 | 中   |
| WP-36 | vibe-maintain：maintenance.yml、工作量计数、内置 cron、去重/上限/暂停、git 体检规则 | `plugins/vibe-maintain/**`                                                                           | WP-10,32 | 中   |

- WP-30 验收：超上限时最久未用条目降级到 `*_ARCHIVE.md`（确定性，不调用模型）；去重/最近使用；单测含边界（空文件、超大单条）。
- WP-31 验收：Claude 经 `agent.create` 钩子 `systemPrompt` 追加；Codex/Kimi/DeepSeek 写带标记的生成区块（优先用被 `.git/info/exclude` 忽略的覆盖文件，若 Codex 不支持再退回 AGENTS.md 标记块——实现时实测）；顺序“用户指令→项目指令→记忆→本次任务”；派发简报只指向文件、声明只读权威。
- WP-32 验收：新草稿 30s 防抖后（测试里缩短）出现评估评论（含清晰度、澄清问题、重复/冲突、拆分与标签、规模与推荐 agent、风险与检查项）；评估 JSON 经 zod 校验；总 agent 不移动卡片；订阅切换后继续处理同一批卡片（mock）；额度错误只发提醒。
- WP-33 验收：每卡独立规划会话；3 轮讨论后方案写回字段并产生 `plan_version`；转 todo 时生成交接摘要写会话 .md，执行 agent 简报引用它，规划会话归档。
- WP-34 验收：额度紧张（mock `listUsage`）时高优先级先拿强 agent；并发取全局/单 provider/设备池三者最小；内存超阈值暂停出队；端口不冲突；单测+一次真机资源采样（Windows）。
- WP-35 验收：时间驱动（假时钟）：空闲且距到期不足余量才触发；缓存热不压缩；等待权限的会话跳过；同一空闲期只一次；Claude 发 `/compact`，不支持则交接；压缩后卡片有 `session.compacted` 事件。
- WP-36 验收：累计完成 10 张卡（假事件）后出现 1 张 git 体检草稿卡；去重键已有未关闭卡只追加；每日上限；连续驳回自动暂停；git 体检在真实临时仓库上跑通。

### 批次 4（P3；依赖批次 1–3 相应部分）

| WP    | 名称                                                                    | 拥有                                                                                                    | 依赖        | 难度 |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------- | ---- |
| WP-40 | [core] App 离线：本地库、同步引擎、RPC 本地提供者、插件 bundle 离线保留 | `packages/app/src/vibe/{store,sync,rpc}/**`、`plugins/{registry,catalog-sync}.ts(x)`、生成副本目录      | WP-02,13,41 | 难   |
| WP-41 | 服务端同步端点（插件 RPC）                                              | `plugins/vibe-board/server/sync/**`、`shared/sync-rpc.ts`                                               | WP-10,13    | 难   |
| WP-42 | [core] 会话汇总页与卡片状态角标                                         | `packages/app/src/vibe/sessions/**`、汇总路由；角标 `plugins/vibe-board/client/badges/**`               | WP-12,40    | 中   |
| WP-43 | 离线回复队列                                                            | `packages/app/src/vibe/replies/**`、`plugins/vibe-board/server/replies/**`                              | WP-40,41    | 中   |
| WP-44 | [core] 推送：网关、最小正文、原生 FCM token                             | `packages/server/src/server/push/**`、`push-notifications/**`、`services/vibe-push-gateway/**`          | —           | 中   |
| WP-45 | vibe-stats：usage indexer 与总览页                                      | `plugins/vibe-stats/**`                                                                                 | WP-01       | 难   |
| WP-46 | iOS（远程 macOS 执行器）与桌面应用采集器                                | `plugins/vibe-verify/server/collectors/{ios,desktop}/**`                                                | WP-20,01    | 中   |
| WP-47 | 性能慢记录规则                                                          | `plugins/vibe-maintain/rules/perf-slow/**`                                                              | WP-36,20    | 中   |
| WP-48 | 中继部署脚本与连接文档、[core] 密码强制                                 | `deploy/relay/**`、`docs/vibe/CONNECTIVITY.md`、`packages/server/src/server/{config,bootstrap}.ts` 小改 | —           | 简   |

- WP-40 验收：vitest（node 内存 sqlite 驱动适配）覆盖本地 RPC 全集；`vibe-shared` 生成副本 `--check` 通过；**飞行模式验收**：Android 模拟器 `adb shell cmd connectivity airplane-mode enable` 后可打开看板、增删改卡片；重连后零丢失。
- WP-41 验收：双副本（服务端+模拟客户端）使用 WP-13 的模糊测试驱动 RPC；“离线改 20 张卡重连零丢失”自动化；非法列迁移被拒并回传权威值。
- WP-42 验收：排序为“等待回复(按等待时长)→运行中→刚结束待验证”，复用 `deriveAgentStateBucket`；单测+模拟器截图；离线时显示“截至 hh:mm”。
- WP-43 验收：离线写回复→重连先校验仍 pending 再发；已失效不发送并提示。
- WP-44 验收：网关单测（假 FCM 端点，dry-run）；daemon 配 `daemon.push.gateway` 后推送正文只含项目名+事件类型（快照断言无助手消息文本）；无配置时行为与上游完全一致（回归测试）；真机 FCM 需用户提供 `google-services.json`（不入库）→ 标“待用户”。本机用本地进程跑网关。
- WP-45 验收：解析器按版本适配 Claude `~/.claude/projects/**/*.jsonl`、Codex `~/.codex/sessions/**/rollout-*.jsonl`、Kimi、DeepSeek（`~/.dsh/sessions`，**路径需实机核实**）；按文件偏移增量；与 `npx ccusage` 对账总量一致（测试夹具 + 本机真实日志对账脚本）；总览页含 token 分布、输出速度中位/P90、费用、额度窗口、任务效率、资源。
- WP-46 验收：
  - iOS：`IosCollector` 通过 **`RemoteMacExecutor`**（经系统 `ssh`/`scp` 调 `<MAC_HOST>` 上的 `xcrun simctl`：boot、install、launch、io screenshot/recordVideo、crash logs，产物回传）。macOS 检测（`ssh <MAC_HOST> 'uname && xcodebuild -version'`）失败时降级为“不可用”并在证据注明。**只做本地 mock 测试**（注入假 ssh 进程，断言命令行、转义、超时、产物回传）；**实机验证标为“待用户在 Mac 上装好 Xcode（及 Node/Homebrew 如需）”**。主机别名、用户名等只来自用户本机 `~/.ssh/config` 与插件设置，仓库内只写 `<MAC_HOST>`。
  - 桌面应用：构建后启动、窗口截图（Windows 下 PowerShell/`System.Drawing`，抽象成 Runner）、操作 GIF、日志；以本仓库 Electron unpacked 包（BUILD.md §2）做 `VIBE_E2E_DESKTOP=1` 真集成。
- WP-47 验收：人为制造的慢查询（夹具）被识别→先复现→修复→证据含修复前后耗时对比→进入 `verifying`；无把握降级草稿卡；按调用点去重。
- WP-48 验收：见下“中继部署”。

**推迟（不在 WP 清单）**：固件仿真（QEMU/Renode/Wokwi）与硬件在环（probe-rs/OpenOCD/串口/摄像头/sigrok）。`vibe-shared` 的 `EvidenceCollector`/`Runner` 接口保持通用，日后加采集器即可；`vibe_*` 数据模型里 `evidence_file.simulated` 与 `device` 表为其预留。

### 批次 6（第三轮反馈，2026-10-21；需求见 PRODUCT-REQUIREMENTS.md「第三轮反馈」）

| WP     | 名称                                                        | 拥有                                                                                                                                                                                                                                                                                                                    | 依赖   | 难度 |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| WP-90  | 契约：项目多类型/简介/需求文档、预设多用途、群聊与提案事件  | `plugins/vibe-shared/**` 及生成副本；消费者为通过编译所需的最小改动                                                                                                                                                                                                                                                     | —      | 中   |
| WP-91  | 看板 UI：项目编辑、需求文档、预设表单、手动触发、输入框光标 | `plugins/vibe-board/client/{presets,board,common}/**`、`plugins/vibe-board/server/requirements/**`                                                                                                                                                                                                                      | 90     | 中   |
| WP-93  | 总 agent：历史会话、交接、可配置触发与提示词、项目上下文    | `plugins/vibe-master/**`、`skills/vibe-master/**`                                                                                                                                                                                                                                                                       | 90     | 中   |
| WP-94  | 自动维护规则可配置                                          | `plugins/vibe-maintain/**`                                                                                                                                                                                                                                                                                              | 90     | 中   |
| WP-95  | [core] vivo 官方推送                                        | `services/vibe-push-gateway/**`、`packages/server/src/server/push/**`、`packages/app/src/push-notifications/**`、App 配置插件                                                                                                                                                                                           | —      | 难   |
| WP-98  | Agent 行为中心（第一部分）                                  | `plugins/vibe-shared/{contract/prompts.ts,db}` 提示词注册表（`prompt_template`/`prompt_override`，core 迁移 5，手机可同步覆盖）；vibe-master 与 vibe-board 的全部提示词接入、高级自动化参数设置项；`plugins/vibe-board/client/behaviour/**` 中央「Agent 行为」页；[core] 插件导航 `openPluginScreen/openPluginSettings` | 90,93  | 中   |
| WP-99  | Agent 行为中心（第二部分）                                  | vibe-verify、vibe-context、switch-provider 的提示词注册与设置界面，以及其余硬编码自动化参数转成设置                                                                                                                                                                                                                     | 98     | 中   |
| WP-92  | 卡片群聊                                                    | `plugins/vibe-board/client/{detail,planning}/**`、`plugins/vibe-board/server/{chat,dispatch,finalizer}/**`；vibe-master assess/planning、vibe-verify review 的发言接入                                                                                                                                                  | 91,93  | 难   |
| WP-105 | 卡片五 tab：方案/执行对话、未读、总 agent 退出卡片流程      | `plugins/vibe-board/{client,server}/**`、`plugins/vibe-master/server/{planning,wake,assess}/**`、`plugins/vibe-shared/**`（core 迁移、命令层）、vibe-verify 复核顺序；[core] App 离线映射                                                                                                                               | 92,104 | 难   |

- **WP-90**：`Project.projectTypes`（非空数组）取代单值，`projectType` 保留为 `projectTypes[0]` 的兼容字段（`COMPAT(project-types)`，旧手机端仍可同步）；
  `Project.description`、`Project.requirementsPath`（默认 `PRODUCT-REQUIREMENTS.md`）；`Preset.roleHints`（数组）取代 `roleHint`，同样保留兼容字段。
  事件：`chat`（作者 user/master/executor/reviewer/scout/system，可带 sessionId）、`proposal`（总 agent 对标题/描述/验收标准的修改建议，状态 pending/accepted/rejected/superseded）；
  命令层 `acceptProposal`/`rejectProposal`；总线事件 `card.review_requested`（WP-105 起无人发布、无人消费，仅为协议兼容保留）。
  共享工具 `requirements-doc`：读取、写入并只对该文件 `git commit -- <path>`（仓库处于 merge/rebase 中时拒绝），不推送。
  验收：迁移含旧数据升级测试；sync-spec 覆盖新字段；`vibe:sync-shared:check` 通过；各消费者 typecheck/test 通过。
- **WP-91**：项目行可编辑全部字段；类型多选；需求文档查看（Markdown）与编辑保存；预设「用途」多选、「思考强度」按 providers catalog 的模型档位单选（含「默认」）；
  「立即执行」（WP-105 改为 `vibe.exec.start`；「让总 agent 审查」已删除）；`TextField` 获得焦点期间不被外部值覆盖（修光标漂移）。
- **WP-93**：切换总 agent 不归档旧 agent，界面列出历次总 agent 会话可打开；新总 agent 首轮带交接摘要；
  设置可改：各触发开关、防抖、补扫数量，规则补充与各唤醒模板（展示默认值、占位符说明、恢复默认）；项目块含简介与需求文档摘录；
  卡片完成时总 agent 可返回需求文档更新，经共享工具写入提交。（WP-105 删除了草稿审查相关的触发开关、防抖与补扫数量。）
- **WP-94**：规则在界面查看与编辑（存插件状态；`maintenance.yml` 仍生效并覆盖界面值，界面标出来源）；**WP-102**：规则只定义一份、多选适用项目（设置 `rules` v2），yml 退为单项目局部覆盖，运行状态按规则×项目分别统计；可编辑提示词模板；生成的草稿卡与提示词用中文说清发现与建议；手动立即运行。
- **WP-95**：网关增加 vivo 发送器（鉴权签名、发送、测试推送模式，假端点单测）；token 带通道类型（协议新增可选字段）；
  App 用配置插件接入 vivo 推送 SDK（SDK aar 与 AppID/AppKey 从本机未入库位置读取，缺失时不启用，构建照常）；FCM 路径不变。真机验收待用户提供凭据。
- **WP-92**（已由 WP-105 取代）：卡片群聊。`chat` / `proposal` 事件、关键消息原则和「查看完整会话」入口沿用到 WP-105 的方案对话与执行对话；总 agent 审查和按列路由已删除。
- **WP-105**（取代 WP-92 的群聊与 WP-91/93 的「总 agent 审查/派发」）：卡片详情五个 tab——详情、方案、执行、验证、时间线。
  - **数据（core 迁移 7 `card_tabs`）**：`card` 新增 `scout_preset_id`、`planner_preset_id`（与 `preset_id`=执行模型、`reviewer_preset_id`=复核模型并列，双向同步）；
    `plan_json`（唯一一版方案，`PlanSnapshot` 结构，覆盖写；迁移时由最新 `plan_version` 回填，`plan_version` 只读保留历史）；
    `model_acceptance`（规划模型最近一次写入的验收标准）；`plan/exec/verify_activity_at`（daemon 写，作为显示列下发）与 `plan/exec/verify_seen_at`（已读位置，双向同步、字段级 LWW）。
    未读 = `activity_at > seen_at`，客户端纯函数计算；打开 tab 时把 `seen_at` 写成该 tab 的 `activity_at`（不用本机时钟，避免手机时钟偏差）。离线经 App 本地 `vibe.cards.update` 同步。
  - **对话**：仍是 `chat` 卡片事件，body 新增 `thread: "plan"|"exec"`；旧消息按作者归类（executor/reviewer/系统派发与转发 → exec，其它 → plan）。
    `events.add` 在同一事务里按 `activityTabsOf(event)` 盖 activity：非用户的 plan 消息、提案、`note{kind:"plan_updated"}` → plan；非用户的 exec 消息 → exec；
    复核结论 → exec+verify；`status{kind:"verification"}`、`reject` → verify。
  - **方案流程（vibe-master/server/planning）**：「制定方案」= `vibe.plan.start` 写一条 plan 线程用户消息（`action:"make_plan"`）；规划器轮询到后，若选了探路模型先跑探路（`master.plan.explore`），
    再用卡片的**规划模型预设**（不再用总 agent 的订阅）在项目仓库里以只读模式开规划会话。回复格式 `{reply, research, plan{text,files}, acceptance, proposal}`。
    `cards.setPlan` 覆盖 `plan_json` 并写 `plan_updated` 事件；验收标准：卡片为空或等于 `model_acceptance` 时直接覆盖，否则（用户改过）发 `proposal{acceptance}` 由用户在方案对话采纳。
    规划模型换了预设：归档旧会话，新会话首轮带上方案对话关键消息 + 当前方案 + 验收标准（`master.plan.start`）。没有交接摘要文件，方案就在卡片上。
  - **执行流程（vibe-board）**：「立即执行」= `vibe.exec.start`（草稿先移到待办，再 force 派发）；派发简报 = 描述 + 方案 + 验收标准 + 执行对话近期消息。
    执行中改执行模型 = `vibe.exec.switch`：沿用失败改派的接续（原生会话转换，否则简报 + 转录 + `board.switch_model` 接续说明）。执行对话的用户消息由 chat router 转给执行 agent；
    执行 agent 不在线时按 agent 句柄恢复（WP-103 resume）再发，失败则写系统消息提示重新「立即执行」。不再回退给总 agent。
    vibe-verify：卡片选了复核模型时**先复核**，严重问题直接退回执行 agent（跳过本轮证据验证），否则再做证据验证；复核为空跳过。
  - **总 agent 退出卡片流程**：删除草稿自动/手动审查（`assess_draft`、`card.review_requested` 消费、`vibe.cards.request_review`）、执行提问时的建议（`session_help`）及其设置与提示词；
    卡片完成后整理项目记忆与需求文档（`card_done`）保留。自动派发仍只来自 vibe-scheduler（`scheduler.admitted` → 看板派发），与总 agent 无关。
    执行阶段的探路（MCP `vibe_scout`、看板 `scout*` 设置、`board.scout_*` 提示词）删除；探路只在制定方案时进行。设置版本号 +1 并在 `migrate` 中丢弃旧键。
- **WP-98 / WP-99**：提示词注册表在 vibe-shared（core 迁移 5：`prompt_template` 由注册插件启动时 upsert 默认值与元数据、从不改覆盖；`prompt_override` 以 `<key>@<项目id|*>` 为行 id，仅 `text` 字段按字段 LWW 同步，空串 = 无覆盖）。
  命令层 `store.prompts.{register,resolve,body,setOverride,clearOverride,list}`：项目覆盖 > 全局覆盖 > 默认；`{{占位符}}` 单次渲染（未声明占位符的提示词原样返回）后追加 `fixedSuffix`（解析所需格式，界面只读）。
  手机策略：`prompt_template` 为 down 表只读；`prompt_override` 只能写已注册 key 的 `text`，不能删除。中央页在 vibe-board（`vibe.prompts.list/set/clear`），按注册表自动列出，不写死插件。
  新增提示词的插件：定义 `PromptDef`、启动时 `register(defs, {pruneMissing:true})`、用 `resolve` 取文本。`master.rules` 变化按文本哈希在下一条消息重发。
  卡片详情编辑框修复轮询回写导致的光标漂移。
  WP-99 接入方：vibe-verify（8 项）、vibe-context（5 项）；它们的新设置页与 vibe-maintain / vibe-scheduler 的「高级」组共用每个插件内一份相同的 `client/settings-kit.tsx`（声明式字段列表）。
  switch-provider 来自上游、要保持可单独安装，不依赖 vibe.db：文字作插件设置，中央页只放链接（`AUTOMATION_LINKS`）。

### 中继部署（WP-48 仅写脚本与文档，**不连接、不执行**）

目标主机：腾讯云 AlmaLinux 8，已有 Docker 与 nginx，是**共用生产机，还有其他站点**。约束：

1. 中继用**独立 docker 容器**，端口只绑定 `127.0.0.1:<RELAY_PORT>`；容器无特权、`restart: unless-stopped`、资源限制、独立 compose 项目名与网络。镜像从官方 getpaseo/paseo-relay 仓库按固定 ref 构建（脚本里 ref 作参数）。
2. nginx **只新增一个独立站点文件**（`/etc/nginx/conf.d/vibe-relay.conf` 一类，文件名由脚本参数给出），`server_name <RELAY_DOMAIN>`，443 TLS（证书路径用占位符，证书由用户用已有方式签发），`location /` 做 WebSocket 反代到 `127.0.0.1:<RELAY_PORT>`（`Upgrade`/`Connection` 头、长超时）。**不得修改任何现有 nginx 配置与其他站点**；脚本先 `nginx -T` 备份摘要、`nginx -t` 通过后才 reload；失败自动撤销新增文件。
3. 部署脚本（`deploy/relay/{docker-compose.yml,nginx-site.conf.template,install.sh,uninstall.sh,README.md}`）入库但**只能由用户在服务器上手动执行**；脚本参数化（`RELAY_DOMAIN`、`RELAY_PORT`、`RELAY_REF`），仓库内不出现真实 IP/域名/用户名；含 `--dry-run` 只打印将执行的动作。防火墙/安全组只需放行 443（已有）。
4. 本地验证：用本机进程跑 `daemon` + 一个本地中继进程（若官方中继需要 Elixir 环境则改用 `packages/relay` 的 cloudflare-adapter 在 `wrangler dev` 下跑，二选一，以 WP-48 实测为准）+ Node 小代理模拟 nginx 的 Upgrade 行为；`nginx -t` 对模板的语法检查可在测试里用占位符渲染后离线校验（若本机无 nginx 则只做模板渲染单测）。
5. daemon 侧：`daemon.relay.{enabled:true,endpoint:"<RELAY_DOMAIN>:443",useTls:true}`；App 配对走现成二维码流程（P0#3，待域名与服务器就绪后由用户执行）。
6. 推送网关（WP-44）同机另起一个 127.0.0.1 容器/进程，由同一站点的另一个 `location /push/` 反代（或第二个站点），同样不碰其他站点。

---

## 8. 测试与验证约定

- 每个 WP 先写失败测试再实现；外部工具一律经可注入 `Runner`；真环境测试用 `VIBE_E2E_*` 环境变量开关，默认跳过，CI 只跑单元。
- 插件测试用 `:memory:` 或临时 `VIBE_HOME`；`PaseoApi`/`PluginServerContext` 用手写 mock（参考 `plugins/vibe-board/test/tasks.test.ts` 与 `packages/server/src/server/plugins/*.e2e.test.ts`）。
- 带 UI 的 WP 必须附 Web 与 Android 模拟器截图（Paseo 内置浏览器/ adb），对应 `docs/qa.md` 证据标准。
- 每次合并上游前先跑 `plugins/*` 测试（FORK-WORKFLOW §2）；每个插件 `paseo-plugin.json` 的 `requirements.paseo` 写 `>=0.12.0 <0.13.0`。
- 提交：普通提交英文信息；`[core]` 提交单独成提交、只做一件事（FORK-WORKFLOW §3）。

## 9. 风险与需要用户决策

### 已设默认（无需回复即按此推进）

| 项              | 默认                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 试点项目     | 本仓库自身（Web + 后端）与其 Android App                                                                                                                                                   |
| iOS 取证        | **有局域网 Mac（经 SSH）**：daemon 经 SSH 调远程 macOS 执行器；实现+本地 mock 测试，实机验证待用户装好 Xcode（Mac 目前只有 Command Line Tools，无 Xcode/Node/Homebrew）                    |
| 硬件取证        | **暂不做**，推迟；P3#6 仅 iOS 与桌面应用                                                                                                                                                   |
| 中继            | 已有腾讯云主机（共用生产机）：独立 docker 容器仅绑 127.0.0.1 + 新增 nginx 站点；脚本入库不执行                                                                                             |
| 同步算法        | 自研字段级 LWW+HLC+墓碑+分数索引，**不用 TinyBase**（理由：看板数据要被 MCP/CLI/多插件按 SQL 读写，TinyBase MergeableStore 会成为第二个真相源且无 `node:sqlite` 持久化器；语义与方案一致） |
| 服务端同步      | 用插件 RPC 当传输，不改 `packages/server`                                                                                                                                                  |
| 推送网关        | 独立 Node 小服务，不改 Elixir 中继（方案写“中继同时承担 FCM 转发”，改为“与中继同机部署”）                                                                                                  |
| 会话结束→待验证 | 一轮 `completed` 且无待答问题即进入；用户续聊则回进行中                                                                                                                                    |
| 总 agent 定时   | vibe-maintain 自带 cron，不依赖 Paseo Schedules                                                                                                                                            |
| 数据位置        | `~/.vibe/vibe.db`（`VIBE_HOME` 可覆盖）                                                                                                                                                    |
| mDNS            | 不做；LAN/Tailscale 地址作为额外 connection，由 App 现有探测选路                                                                                                                           |

### 需要用户决策

1. **中继对外域名**（`<RELAY_DOMAIN>`）与证书签发方式：WP-48 脚本参数，合并前必须给定（仅在你本机/服务器使用，不入库）。
2. **Android 离线路线**：默认“插件 UI + [core] 本地 RPC 与 bundle 离线保留”（改动小、UI 单份）；若 WP-02 实测不可行则退回“App 原生页面”（UI 写两份）。WP-02 出结论后请确认。
3. **Mac 端准备**：装 Xcode（及后续是否需要 Node/Homebrew），并确认 SSH 免密别名（只在你本机配置）。装好前 iOS 取证仅 mock 验证。
4. **FCM**：需要你提供 Firebase 项目的 `google-services.json`（本机构建 APK 用）与服务账号（放服务器），均不入库；未提供前推送只做 dry-run 验证。

### 主要风险

| 风险                                                     | 应对                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Hermes `eval`/路由离线可达性未实测                       | WP-02 先做，结论回写本文                                                  |
| 多个插件进程同写 SQLite                                  | WAL+`busy_timeout`+`BEGIN IMMEDIATE`；命令层统一写入；并发测试在 WP-01    |
| 编译器边界导致共享代码只能复制                           | 同步脚本+`--check`；`file:` 依赖经 spike 可行但不采用（SPIKE-SHARED.md）  |
| 上游改 `plugins/registry.ts`/`catalog-sync.tsx` 造成冲突 | C1/C2 极小钩子化、单独 `[core]` 提交、两周合并时优先回归                  |
| 钩子事件不重放（daemon 重启丢事件）                      | 派发/会话状态以 `agent_session` 为准，启动时用 `paseo.agents.list()` 对账 |
| 推送正文泄露                                             | 默认 `minimalPayload=true` 并有快照测试                                   |
| 本机缺 maestro/docker/playwright                         | 采集器降级路径+显式标注；不阻塞                                           |
| 验证证据可信度                                           | 只读强制三重检查、证据带 commit 哈希与 `simulated` 标记                   |

## 10. 依赖图（简）

```
WP-00 ─┐
WP-01 ─┼─▶ WP-10 ─▶ WP-11, WP-12, WP-14 ─▶ WP-20 ─▶ WP-21, WP-46, WP-47
WP-02 ─┘      │         │                      ├─ WP-22, WP-23 (仅需 WP-01 接口)
WP-13 ◀─ WP-01 ──────────┼──▶ WP-41 ─▶ WP-40 ─▶ WP-42, WP-43
WP-30 ◀─ WP-01 ─▶ WP-31 ─▶ WP-32 ─▶ WP-33, WP-36 ─▶ WP-47      WP-35 ◀ WP-30,31
WP-34 ◀ WP-01,12      WP-44, WP-45, WP-48 基本独立
```
