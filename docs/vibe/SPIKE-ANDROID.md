# WP-02：Android 插件 UI 验证 spike

实测日期：2026-10-19。基于 paseo 0.12.0（main），Android 模拟器（x86_64，1080x2400），
debug APK `sh.paseo.debug`（BUILD.md §3 产物），daemon 用隔离 home（监听 127.0.0.1:16767，经 `adb reverse` 映射）。
本 spike 未改动、未提交任何源码；实验用的临时插件放在仓库外。

## 结论摘要

| 问题                                                    | 结论                                                                                                | 证据                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1. 插件客户端 bundle 在 Android 上能否 eval、渲染、交互 | **可行**                                                                                            | 截图 02、03、04；Hermes 下 `globalThis.eval` 正常，Tasks（vibe-board）整屏渲染、点击、RPC 往返均正常                     |
| 2. 断线后插件 UI / 路由                                 | **断线即不可用（现状）；路由本身可达，`HostRouteBootstrapBoundary` 不是阻碍**                       | 截图 06；`catalog-sync.tsx` 断线 `removeHost`，页面显示 “This plugin surface is unavailable.”；重连后自动恢复（截图 07） |
| 3. RN 组件/手势、拖拽排序、性能                         | **整个 `react-native` 模块可用，拖拽排序可用（PanResponder）；Reanimated / gesture-handler 不可用** | 截图 05；`evaluate.ts` 的 `runtimeRequire` 白名单；性能见 §3                                                             |

对 WP-40 的建议：**走默认路线（插件 UI 一份 + [core] 本地 RPC 与 bundle 离线保留）**，不需要退回“App 原生页面”。
改动集中在 `packages/app/src/plugins/` 与 `app/_layout.tsx`，路由与启动边界无需改。

## 1. 安装、eval、渲染、交互

### 环境与步骤

1. 隔离 home：`$PASEO_HOME/config.json` 写 `{"pluginsEnabled":true,"daemon":{"listen":"127.0.0.1:16767"}}`。
   `daemon.listen` 写进 config 对 `daemon start` 有效（BUILD.md 说环境变量 `PASEO_LISTEN` 无效，改 config 即可换端口）。
2. `plugin install <plugins/vibe-board 绝对路径>`：目录插件安装时 esbuild 需要解析 `@getpaseo/client` 等类型依赖。
   worktree 没有插件自己的 `node_modules` 时报 `Could not resolve type dependency "@getpaseo/client"`；
   用 `mklink /J plugins\vibe-board\node_modules <主目录>\node_modules` 联接后安装成功，状态 `running`。
   插件 manifest 的 id 是 `tasks`（上游 Tasks 插件原样），路由里 pluginId 用 `tasks`。
3. `adb -s <模拟器序列号> install -r app-debug.apk` 成功（约 21 秒，485 MB）。**只装到模拟器，没碰真机。**
4. **debug APK 不内置 JS bundle，必须有 Metro**（dev client）。启动 `APP_VARIANT=development npx expo start --dev-client --port 8081`，
   `adb reverse tcp:8081 tcp:8081`，再用 `exp+voice-mobile://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081` 拉起。
   首次打包 6517 个模块约 145 秒，期间 App 报 `SocketTimeoutException`；先用 curl 触发一次完整 bundle 预热后重试即可。冷启动加载已缓存 bundle 仍需约 20 秒。
   WP-23 的 Android 采集器如果依赖 debug APK，必须自带 Metro 或改用 release 变体。
5. 连接：欢迎页 → Direct connection → host `localhost`、port `16767`（经 `adb reverse`）。输入框在软键盘弹出后布局会上移，adb 点坐标前要先截图。

### 观察

- 插件路由 `h/<serverId>/plugin/tasks/surface/main`（kind 是 `surface`，见 `plugins/routes.ts`、`surface-screen.tsx`）
  用 `adb shell am start -a VIEW -d paseo:///h/...` 即可直达。
- Tasks 看板整屏渲染：顶栏、Board/List 切换、过滤 chip、五栏看板（横向滚动）、空状态按钮。
- 点 “Seed Sample Projects & Tasks” 走插件 RPC 成功，提示 “Created 3 sample projects & 12 tasks”（截图 02）。
- 点卡片上的 “→” 把 OPS-3 从 Backlog 移到 Todo，列计数与卡片位置立即更新（截图 03）：`invokePluginRpc` 往返 + 重新取数在回环网络下观感 1 秒内。
  RPC 耗时未做精确打点（需改 App 代码），仅为观感；真实网络下的耗时需另测。
- 侧栏 header item（Tasks 带角标 9）正常出现（截图 04），其余贡献点由同一 registry 注册。
- **热更新**：daemon 上 `plugin install` 另一个临时插件后，App 不重启即刷新出新的侧栏项；`plugin reload` 后新 bundle 立即生效
  （`status.plugin_catalog_changed` → `refresh(pluginId)`）。
- **eval**：`packages/app/src/plugins/evaluate.ts` 用 `globalThis.eval(bundle)`，在 Hermes 上可用，无 CSP/禁用问题。
  bundle 是 daemon 编译好的 CJS 字符串，通过 `runtimeRequire` 注入 react / react-native / zod / @tanstack/react-query / `@getpaseo/plugin/*`。

## 2. 断线行为与离线保留

### 现状（实测）

- 停掉 daemon 后，已打开的插件页立即变为 “This plugin surface is unavailable.”（截图 06）。
- 杀掉 App 进程、daemon 离线冷启动，再 `am start` 深链到插件路由：路由可达（标题显示插件 id `tasks`，同样提示 unavailable）。
  注意：冷启动后 JS 约 20 秒才就绪，过早发的深链会被丢掉，只看到空白底色，容易误判成路由被挡。
- 重连 daemon 后无需操作，插件被重新装载、数据照常（数据在 daemon 侧，截图 07）。

### 原因（源码）

1. `plugins/catalog-sync.tsx`：`PluginCatalogSync` 在 `!supported || !audio` 或 `!connected` 时调用 `pluginRegistry.removeHost(serverId)`；卸载 effect 也会 `removeHost`。
   `removeHost`（`plugins/registry.ts`）会 `dispose` 所有安装并清空 `byHost`。
2. `plugins/surface-screen.tsx`（`PluginSurfaceScreen`）：`useInstalledPlugin` 取不到插件 → 渲染 “unavailable”；
   即便取到，`plugin && surface && client` 里的 `client`（`useHostRuntimeClient(serverId)`）离线时也可能为 null，此时显示 “Plugin host is offline.”。
3. `registry.ts` 的 `installCatalog`：每个 `InstalledPlugin` 的 `invoke` 直接绑 `client.invokePluginRpc(entry.id, method, input)`，`paseo: createPaseoApi(client)` 也绑 daemon client。
4. `app/_layout.tsx` 的 `ManagedDaemonSession`：`client` 为 null 时整棵 `SessionProvider`（含 `PluginCatalogSync`）不渲染。

### `HostRouteBootstrapBoundary` 结论

`components/host-route-bootstrap-boundary.tsx` 只在 `startupBlocker.kind !== "none"` 或 `hostRegistryStatus === "loading"` 时显示启动页。
`startupBlocker` 仅在桌面端（`isDesktopRuntime`）托管本地 daemon 启动期才非 none（`navigation/host-runtime-bootstrap.ts: resolveStartupBlocker`），**Android 上恒为 none**；
registry 加载只影响启动初期。并且插件路由 `h/[serverId]/plugin/...` 的组件（`PluginSurfaceScreen`）**没有包这个 boundary**
（只有 agent、workspace、settings、open-project、schedules、sessions、插件设置页包了）。
`h/[serverId]/_layout.tsx` 的 `KnownHostRoute` 只要 host 在已保存列表里就放行，host 离线也不会重定向。
所以 ARCHITECTURE 风险表里这一项**风险解除**：路由不需要改，改 bundle 保留即可。
仅插件设置页 `settings/hosts/[serverId]/plugins/[pluginId]/[screenId].tsx` 包了 boundary（桌面端受影响，Android 不受影响）。

### WP-40 改动点（建议）

| 文件 / 函数                                                                                                                                 | 改动                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/app/src/plugins/catalog-sync.tsx`：`PluginCatalogSync` 内两处 `removeHost`（`!supported \|\| !audio`、`!connected`）与卸载 effect | 断线时**不再** `removeHost`，保留已评估的安装；重连后仍走原有 `refresh()`，由 `installCatalog` 的 `preserved`（`id + clientBundle` 相同则复用）去重。仅在 host 被用户删除（serverId 从 host 列表消失）时才 `removeHost`                                                                                           |
| 同文件，`refresh` 的 `getPluginCatalog().then` 回调                                                                                         | 成功后把 catalog（`id、clientBundle、requirements`、manifest 必要字段）+ hash 写入本地持久化（replica 库旁新表，或先用 AsyncStorage/文件），key 为 `serverId`                                                                                                                                                     |
| `packages/app/src/plugins/registry.ts`：新增 `restoreFromCache(serverId, cachedCatalog, { provider, audio })`，复用 `installCatalog` 主体   | App 冷启动、host 尚未连上时先用缓存 catalog 评估插件；`installCatalog` 的 `client` 参数泛化为最小接口（`invokePluginRpc` 等）；`createPaseoApi(client)` 在离线下换成“抛 host offline 错误”的桩                                                                                                                    |
| `registry.ts` 同处，`installation.invoke`                                                                                                   | 改为 `rpcProvider.invoke(entry.id, method, input)`：在线走 `client.invokePluginRpc`，离线走 WP-40 的本地 RPC 提供者（`packages/app/src/vibe/rpc/**`，按 pluginId 与方法名分发到本地库）；provider 通过 `createPluginClientRuntime` 的调用处（`this.dependencies.createRuntime(installation, options.audio)`）注入 |
| `packages/app/src/app/_layout.tsx`：`ManagedDaemonSession`                                                                                  | `client` 为 null 时目前整体不渲染；“缓存恢复”要放在不依赖 `client` 的位置（例如根部按已保存 host 列表调用 `restoreFromCache`），在线后再由 `PluginCatalogSync` 接管                                                                                                                                               |
| `packages/app/src/plugins/surface-screen.tsx`：`PluginSurfaceScreen` 渲染条件 `plugin && surface && client`                                 | 去掉对 `client` 的强依赖（或改成 `client \|\| offlineProvider`），否则缓存的插件离线时仍显示 “Plugin host is offline.”                                                                                                                                                                                            |
| `plugins/` 下依赖 daemon 的贡献点（Agent 面板、composer pill、slash command 等）                                                            | 逐个检查离线降级；vibe-board 的 screen/侧栏只依赖 RPC，不受影响                                                                                                                                                                                                                                                   |
| 路由 `app/h/[serverId]/plugin/**`、`HostRouteBootstrapBoundary`                                                                             | **无需改**                                                                                                                                                                                                                                                                                                        |

附带注意：

- 缓存的 bundle 必须带 hash，在线后与 daemon 新 catalog 比较；不一致走原有 `replacePluginId` 替换逻辑，避免“旧 UI 调新 RPC”。
- 插件的 `index.server.ts` 跑在 daemon 上，离线时不存在；本地 RPC 提供者要覆盖 vibe-board 的全部 RPC 方法（与 WP-40 验收“本地 RPC 全集”一致）。
- 本 spike 验证的是“断 daemon”这一层，没有验证飞行模式与同步引擎。

## 3. RN 组件、手势、性能

- **组件**：`runtimeRequire` 的 `react-native` 分支返回整个 `import * as ReactNative`，所以 View/Text/Pressable/ScrollView/FlatList/Modal/Animated/PanResponder/TextInput 等内置全部可用；
  另有 `@getpaseo/plugin/client/ui`（Settings\*、SidebarRow 等宿主组件）与 `@getpaseo/plugin/client/react-native`（Modal、ScrollView、FlatList、TextInput 封装）。
  **白名单之外的模块一律抛 `Module "..." is not available in plugin client code`**：`react-native-reanimated`、`react-native-gesture-handler`、`@shopify/flash-list` 等不可用。
- **拖拽排序：可行**，用 `PanResponder` + `transform: translateY` 实现。仓库外的临时插件（5 行列表），用 `adb input swipe` 拖第一项向下，
  松手后顺序由 `Alpha,Bravo,…` 变为 `Bravo,Alpha,…`（截图 05）。
  两个坑：① `PanResponder.create` 必须放进 `useRef` 只创建一次（每次 render 重建会丢失拖拽状态，第一次实验就因此失败）；
  ② 拖拽中每次 move 都 `setState`，一次拖拽约触发 8 次渲染，生产实现建议用 `Animated.Value` 驱动位移，并在拖拽时关闭外层 ScrollView 的 `scrollEnabled`。
  没有 Reanimated，手感会逊于原生手势库；**跨列拖拽未实测**（需自行做命中检测）。WP-11 已规划 compact 下的 Move-to 菜单作为兜底，足够。
- **性能观感**：模拟器上 debug 构建（JS 开发模式、软件渲染）横向滑动看板可见卡顿，`dumpsys gfxinfo` 约 63 帧中 97% 为 janky，P50 帧耗时 97ms。
  **这是 debug + x86 模拟器数据，不代表真机 release**，不能据此下结论；性能应在 release 构建/真机或 arm64 AVD 上补测。
  12 张卡片的静态首屏无明显等待，点击响应及时。大 bundle 的 eval 耗时本次未单独测量。

## 4. 对 Android 离线路线的建议

1. **推荐：插件 UI 一份 + [core] 本地 RPC / bundle 离线保留（ARCHITECTURE §3.7 的方案 3）**。
   理由：渲染、交互、RPC 往返、热更新、拖拽手势在 Android 上均已实测可行；断线问题源于 `catalog-sync.tsx` 的 `removeHost`，改点集中且小，路由和启动边界不用动。
2. **不建议**退回“App 原生页面（UI 写两份）”（§3.7 的方案 6），除非 WP-40 实施中发现“缓存 bundle 评估 + 本地 RPC 注入”在某些贡献点上无法与 `createPaseoApi(client)` 解耦。
3. 仍存风险：① 拖拽无 Reanimated，手感需真机验证；② debug APK 依赖 Metro，验证流水线（WP-23）要考虑；③ 离线时依赖 daemon 的贡献点需降级。

## 5. 产物与复现要点

- 截图在 `docs/vibe/spike-android/`：02 看板（已 seed）、03 移动卡片后（RPC 往返）、04 侧栏插件项、05 PanResponder 拖拽排序、06 断线后 “unavailable”、07 重连后恢复。
- 实验用 worktree 里建了 `plugins/vibe-board/node_modules` 目录联接（指向主目录 `node_modules`，已被忽略，不入库）。
- 实验用的拖拽插件放在系统临时目录，非仓库内容，未提交；daemon 与 Metro 均已停止，`adb reverse` 已清除。
