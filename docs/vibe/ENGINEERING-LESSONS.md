# 工程经验教训（WP-136 至 WP-153 提炼）

> 2026-11-01 从各工作包报告提炼，原报告已丢弃。格式：现象 → 原因 → 做法。第 25 条为未实测确认的推测。

## 一、测试与构建环境

1. 沙箱内 vitest 与格式化报 `spawn EPERM`（config loader 起不了 esbuild）：这是沙箱限制，不是测试失败。做法：由沙箱外补跑，报告里写明「已静态检查、未运行」，不要写成通过，也不要绕过。
2. worktree 里 `node_modules/@getpaseo/plugin`、`protocol` 等 junction 指向另一份 checkout，app 或 server typecheck 读到旧声明，报 `addWorkspaceTabProvider`、`cachedOnly`、`agent.turn_context` 等「缺失」。做法：先 `npm run build:client` / `build:plugin`；仍不行就用临时 tsconfig 的 `paths` 映射到本 worktree 的构建产物，验完删掉。不要改 junction，也不要在 worktree 里装依赖。验收要求源码和生成物来自同一检出。
3. 根 `npm run lint` 默认忽略 `plugins/vibe-*`，「0 错误」可能是扫描了 0 个文件。做法：另用清空 ignorePatterns 的临时配置（保留规则，`--no-ignore --disable-nested-config --deny-warnings`）扫改动文件，并与 `git show HEAD:<file>` 的基线逐条比较，只处理新增诊断。根 lint 还会扫到 `.wp/` 里的检查副本，要加 `--ignore-pattern '.wp/**'`。
4. 测试里把表达式箭头函数改成块函数时，`return` 与 `React.createElement(...)` 分两行会被自动分号插入吞掉，返回 undefined，整个组件找不到元素（Switch 五例全挂）。做法：`return` 后同一行开始表达式。
5. zod 4 的 `schema.partial()` 仍会应用字段内部默认值，model-only 的 patch 会把 provider、instructions 等清空。做法：对带默认值的字段先 `removeDefault()` 再 `optional()`；用「model-only patch 的精确解析结果」和「既有资料保留」断言锁定局部更新语义。创建默认值不能直接复用于 patch。
6. 测试桩与真实接口脱节是失败的主要来源：`createAgent(config, id, options)` 少传第三个参数、桩缺 `registerAgentTool` / `tasks.get` / 返回清理函数的 `on`、lifecycle 测试漏列新字段 `labels`。做法：桩跟随真实 ingress 参数和 provider 回显约定（如回显 `clientMessageId`）；改接口时 grep 所有桩。
7. 不要用真实 `setTimeout` 等待断言：用假时钟精确到边界（29+1ms）并在边界前后各断言一次；异步发送用「send 开始」握手事件而不是 sleep。vibe-board 的 tabs 测试含真实 Git 建仓，机器负载高时 Git finalizer 会超时，这是负载问题。
8. startup 类测试不要依赖 RPC 注册顺序（`handlers[0]`），按固定 RPC 标识捕获 handler；需要数据库的初始化用真实 `openBoardRuntime({ path: ":memory:" })`，并在 finally 里释放门闩、关闭服务和数据库。
9. 插件测试里没有可用的 React 渲染链（插件目录与宿主 React 副本不同）：把状态机、轮询间隔、展示状态抽成纯函数测试，不要挂载组件，也别断言渲染次数。
10. 主题新增字号时，要同步外观缩放逻辑与测试 fixture 的行高；换用系统减少动态效果 API 时，同步 Reanimated 的 mock。改共享 `test-stubs` 前，先排除文件内自带 mock 已隔离它的测试，再列出真正消费共享主题的测试去补跑。
11. 插件不在根 npm workspaces 内，测试用 `npm --prefix plugins/vibe-xxx test -- <file>`；新插件目录无法离线安装依赖时（`ENOTCACHED`），用临时 Node 24 typeRoots 配置做类型检查，正式配置不引入跨插件依赖。
12. 误在 worktree 里跑 `pnpm`、`npm install` 类检查会产生 `.pnpm-store` 等残留，并有改坏链接目标的风险。做法：立即中断，只检查，不清理（递归删除被禁止），在报告里登记残留路径。
13. 合并冲突时沙箱可能无法写 worktree 的 `.git/worktrees/<name>/index.lock`（Permission denied）。做法：文件层面解决冲突并清标记，报告 UU 状态，请用户在沙箱外 `git add -- .` 并复核提交，不尝试绕过。

## 二、插件、守护进程与宿主 API

14. 插件 RPC 默认 30 秒超时，宿主时间线请求客户端窗口是 60 秒。凡是会触发 provider 探测的操作（`listAvailable` 对所有 provider 做 `Promise.all`，实测 78 秒）不能放在 RPC 同步路径里。做法：后台单飞任务立即返回 `creating`，状态 RPC 暴露进度，客户端轮询；失败状态保留，由用户重试才重启。
15. 「普通 snapshot」读取会顺带启动后台 warmup，延迟敏感的回退要显式用 `cachedOnly`，冷缓存也不得触发探测；旧宿主会忽略该字段，无法保证只读。回退模型顺序：项目或全局 project 预设 → 最近任务 #1 → 缓存的 provider 默认模型（有 `isDefault` 用它，否则取首个可选项）；项目与全局两个 scope 并行，各 1.5 秒截止。
16. 高频读接口要共享缓存：对 `project.list` 用「同宿主单飞 + 成功后 30 秒 TTL，失败不缓存」，对项目 agent 状态用 15 秒单飞，对占位 resolve 用只读数据库的轻量 RPC。workspace 校验只合并在途请求，不缓存已完成结果（避免用旧状态做创建准入）。实测一次 20 个并发读取合成 1 次。
17. 重试治理：永久失败（非独立 worktree、已归档、不存在）只记一次简短日志并在本次运行期停止重试；暂时失败按 workspace/role 单飞，1/2/4/8/16/30 分钟退避，日志限频、不打堆栈。否则 60 秒 sweep 加事件触发会每分钟刷同一条错误。
18. 创建类 RPC 的幂等：超时后的重试必须复用同一份完整输入和同一代际幂等 key，否则迟到的成功会重复建 agent；只有已知 agent 被归档或失效才换代际。单飞记录只在插件当前运行期有效，重载后靠标签重新发现已有 agent。
19. 项目级的创建状态不能覆盖同项目多个 bot；默认 bot 的 ready 状态也不能按项目长期缓存，否则切换默认 bot 后会打开旧对话。所有打开入口和内部发送调用要各自处理异步状态；旧请求不得覆盖新状态，卸载或切项目后不得迟到导航。
20. Codex 空闲新会话已建 thread 但无 rollout，daemon 重启后恢复报 `no rollout found`，时间线请求被客户端重试 520 次。做法：只对「明确从未收到用户消息、未归档」的会话，且只在命中该特定错误时重建 provider session，保留 agent 身份、配置和元数据；有消息或历史状态未知的会话不走这条路径。
21. 记忆等「个人上下文」通过 provider user-role 前置上下文注入时，必须用 `<paseo-system>` 围栏，不能构成 `/执行` 授权，原始用户消息仍是 canonical timeline 内容；未带 message id 要自动补 id，避免 provider 回显把记忆混进授权来源。记忆版本不能只取最大 `updated_at`（删最后一项或同毫秒编辑会漏检），要保存快照并用 provider 接受回执确认送达。
22. 跨插件代理调用不继承原 agent caller。含个人记忆的列表与用户操作要显式拒绝 agent caller，工具类调用按当前主 agent 身份校验项目范围，防止绕过隔离。
23. 宿主 RPC 方法名只允许小写，用点号分隔（如 `project.default_bot.get`）；改过 `plugins/vibe-shared` 后必须运行 `npm run vibe:sync-shared`，副本不得单独维护，用 `vibe:sync-shared:check` 校验。
24. 迁移约定：旧数据迁移要幂等，迁移创建与来源标记放在同一事务；旧插件暂不可用时独立重试，用户先行编辑优先；旧会话的原生历史和系统提示不重写，下一回合一次性送达角色更新。已归档的旧 agent 也要纳入迁移（权威 ID 优先）。
25. Web 上 RN `Modal`（`ModalFocusTrap`）与宿主 `MenuOverlay` 的 portal 焦点管理会互相夺回焦点，疑似造成下拉卡死（待实测确认）。做法：表单用宿主 Modal，并 memo 下拉选项，模型选项只在所选 provider 变化时重算。
26. 插件看不到宿主 UI 原语和设计令牌，需要的能力走契约扩展（如 `addWorkspaceTabProvider`、会话头部扩展点、侧栏创建动作）；宿主向插件主题传可选令牌，旧宿主要有兼容回退。路由避免同名 `dismissTo` 参数互相覆盖，三个子页用三个独立路由。

## 三、Windows 与本机环境陷阱

27. Node 24 的类型剥离会让 `fallbackCJS` 路径直接加载 Expo `runtime.ts`，其无扩展名的 `require('./ImportMetaRegistry')` 解析失败（13 个 app 测试受影响，CI 用 Node 22 不触发）。做法：在单测 setup 里替换 CJS 缓存中的 winter runtime（URL 为 null），不要用 Vite alias。
28. 沙箱与日用 daemon 并存时：不启动、停止或重启 6767/6868 daemon，分析日志只读（日志里 UTC 毫秒时间戳可用于关联请求窗口）。

## 四、性能诊断方法

29. 先量再改：对日志统计慢请求的 p50/p95/最大、inflight 峰值、Git peakPending、事件循环 max delay，才能区分「插件 RPC 排队」「宿主磁盘扫描」「系统争用」。插件 invoke 不走串行安装队列，不能把所有耗时都归于「RPC FIFO」；日志没有任务号到 agent 的映射时，不能断言某个超时对应哪个任务。
30. 宿主 `project.list` 每次对所有项目构建 descriptor，并重复搜索磁盘图标；这类全量扫描在并发时线性放大。排查「卡顿」先数调用频次（每分钟几次、每次 1+P 还是 P 倍），再看单次耗时。
31. 「加载 Agent 失败」可能是宿主冷恢复耗时超过客户端 60 秒窗口（实测 47～100 秒），与插件 RPC 超时是两条独立链路；处理上先降低同时启动的负载并重试，不要因超时重启日用 daemon。

## 五、UI 与界面验收

32. 沙箱内只能静态检查，三端界面一律标「待实测」。每份报告应附「界面重点」清单：窄屏 375 与 900 宽、Android 长按和横滑、Electron 顶行安全区与拖动区、深浅主题切换、很长的名称或模型名。
33. 修「侧栏与主区之间空白」这类布局问题：侧栏外层不应参与主区剩余宽度的 flex 分配；用截图窗口尺寸核对主区紧接侧栏且内容居中。
34. 新增分组或列表前先排除分类请求进行中的瞬态：尚未分类的 workspace 暂不渲染，否则 bot 对话会短暂重复出现；空分组一律隐藏，查询失败显示「待识别」而不是错分类。
35. 颜色对比要给数值：输入占位用 `textPlaceholder`，深色在控制面/画布上 8.76/9.46:1，浅色 6.65/6.10:1，达到可读后再统一替换所有显式占位色。
36. 横向滚动的 tab 行：两端渐隐、选中项自动滚入；Web 需同时支持纵向滚轮、触控板横滑和鼠标拖动，拖动结束不得误触 tab；详情放悬停提示（Web）和长按菜单（原生）。
37. 历史加载时不要同时打开多个弹层：紧凑布局默认关闭步骤汇总的 sheet。原生倒置列表上的引用定位和 waterfall 滚动要在 Android 实机核验。
38. 新安装默认深色，已有保存的外观选择不变；旧 `auto` 通过 `dark-default` 一次性迁移为 `dark`，迁移后用户再选 `auto` 要保留。设置迁移要有一次性标记。
39. 可视化回复（HTML 文本）的安全：Web/Electron 用只允许脚本的 iframe，Android WebView 禁止文件访问、跨源加载和导航；只放行白名单消息（高度、草稿提议），提议由用户点击宿主按钮后才填入草稿。

## 六、流程与协作

40. 每个工作包在沙箱内常无法验证，报告应分三类写清：已通过的检查（命令加结果）、未执行的检查（原因）、需用户补跑的精确文件清单（逐文件，禁止全量套件）。失败修复轮次里写明判断：实现错误、测试预期过时、测试桩缺失、main 既有失败，分别处理，不削弱断言。
41. 区分「本包引入的失败」与「main 既有失败」：用 `git show main:<file>` 确认；既有失败只改共同测试预期，不去改无关实现。
42. 简单档流程由用户亲选简单档才算执行授权；项目 bot 定的简单档不构成授权。高风险识别依赖关键词，覆盖不全，仍需项目 bot 按提示词判断；自测输出与代码快照在面板刷新或验收时复核，没有后台文件监听。
43. 通用提示词里不要写死角色编号，用占位符，并加「渲染后编号正确」的断言。固定编号为 #1 主会话、#2 方案、#3 探路、#4 执行、#5 复核、#6 验证，额外会话从 #7 起；重新编号要同步推进 `nextTabNumber`。
44. 越界改动要单列：报告里分开写 [core] 文件、为接线不得不动的越界文件（及原因）、共享镜像的生成副本；[core] 提交带 `[core]` 前缀并独立提交。
45. 日志与检查材料放 `.wp/`，不随交付提交；临时 tsconfig、lint 配置、失败输出文件用完逐个单文件删除，不递归删除。
