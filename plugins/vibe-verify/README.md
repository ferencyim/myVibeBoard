# vibe-verify

myVibeBoard plugin. Supported Paseo versions: see `requirements.paseo` in `paseo-plugin.json`.

```bash
npm install   # first time: creates package-lock.json (commit it)
npm run typecheck && npm test
```

## Evidence collectors (WP-22)

`server/collectors/{web,backend}` implement `EvidenceCollector` (see `server/vibe/contract/collector.ts`).
Both read `<worktree>/.vibe/verify.json` (schema: `VerifyConfigSchema` in `server/collectors/common.ts`).
The browser (`BrowserDriver`), processes (`Runner`), dev servers (`ServerLauncher`) and HTTP (`HttpClient`)
are injectable; unit tests use fakes. Real run: `npx playwright install chromium`, then
`VIBE_E2E_WEB=1 npm test`.

### Performance before/after (`backend.perf`, WP-47)

`.vibe/verify.json` may carry `backend.perf`: `{ label, command, args, cwd?, runs (3), thresholdMs?, beforeMs?,
copyToBaseline? }`. The backend collector runs the command `runs` times in the fixed worktree and, when a
baseline worktree exists, in the pre-change commit (files in `copyToBaseline`, e.g. a new bench script, are
copied in for the run and unlinked afterwards), compares the medians and writes `perf-compare.json`.
Judgement: fail if the command fails or `after > thresholdMs`; doubt if under 10% faster or no before timing
(`beforeMs` is accepted as a recorded fallback); else pass. The pipeline creates the baseline worktree for web
projects and whenever the worker's `.vibe/verify.json` has `backend.perf`, injects it, and keeps the worker's
`backend.perf` when the verifier's own config lacks it. vibe-maintain's `perf-slow` rule tells its worker to
write this block.

## iOS and desktop collectors (WP-46)

- `server/collectors/ios`: `createIosCollector` drives `xcrun simctl` (boot, install, launch, screenshot,
  recordVideo, crash reports) on a remote Mac through the system `ssh`/`scp` (`RemoteMacExecutor`, BatchMode,
  no passwords). The host is only an ssh alias from the user's `~/.ssh/config` (`<MAC_HOST>`): plugin option
  `host`, env `VIBE_MAC_HOST`, or `ios.host` in verify.json. `detect()` runs `uname && xcodebuild -version`
  and reports why the Mac is unusable. Scratch files stay in `/tmp/vibe-verify/<run>` on the Mac (never deleted
  recursively).
  **Xcode not selected by `xcode-select`** (Command Line Tools active, or Xcode on an external disk): set
  `developerDir` (plugin option, env `VIBE_MAC_DEVELOPER_DIR`, or `ios.developerDir` in verify.json, an absolute
  path such as `<XCODE_APP>/Contents/Developer`). Every remote command is then prefixed with
  `export DEVELOPER_DIR=...;`, and `detect()` reports a missing directory as "is the external disk mounted?".
  `dispose()` stops only what the run started (recorder, app, and the simulator only if the run booted it).
  Verified on a real Mac (WP-73, Xcode 26.6, iOS 18.6 simulator): boot, `app.appPath` sync + install,
  `app.build` remote `xcodebuild` + install, launch, screenshots, recordVideo (mp4), crash-report scan, GIF,
  pre-running simulator left running. Sample: `docs/vibe/screens/ios-evidence-sample.png`.
  Real run: `VIBE_E2E_IOS=1 VIBE_MAC_HOST=<alias> [VIBE_MAC_DEVELOPER_DIR=...] [VIBE_E2E_IOS_DEVICE="iPhone 16"]
[VIBE_E2E_IOS_APP=<local .app>] [VIBE_E2E_IOS_BUILD_CWD=<project dir on the Mac>] npm test`. A test app is a
  single-file SwiftUI project (`EvidenceApp.swift` + a minimal `project.pbxproj`, bundle id
  `com.example.vibeverify.evidence`, `GENERATE_INFOPLIST_FILE=YES`) built with
  `xcodebuild -scheme EvidenceApp -sdk iphonesimulator -derivedDataPath build CODE_SIGNING_ALLOWED=NO build`.
  On Windows Git Bash set the env vars from PowerShell (MSYS rewrites `/Volumes/...` values).
- `server/collectors/desktop`: `createDesktopCollector` starts the built app, waits for its window, takes
  window screenshots (Windows: PowerShell + user32 PrintWindow; macOS: full-screen `screencapture`, degraded),
  builds a GIF from the step frames, keeps stdout/stderr, and stops only the process it started. For
  Electron apps `automation: "electron"` uses Playwright `_electron` for click/fill/press steps. Apps whose
  launcher exits and hands over to another process (e.g. Windows 11 Notepad) need `windowTitle`.
  Real run on this machine: `VIBE_E2E_DESKTOP=1 npm test`.

## 原生任务验证（WP-112 / WP-115）

新流程只接收已确认的 workspace/task，旧 card.moved、旧验证恢复和旧写操作 RPC 已停用；旧 UI 与只读证据保留到 WP-114 清理。不创建伪卡片，也不复制原生聊天。

任务进入 reviewing/verifying 后，先核对 worktree 的 HEAD 与完整 Git 状态。所有改动（包括 .vibe/verify.json）必须已收口提交。复核模型可选，验证模型必须来自本轮冻结的角色快照；预设后续修改不影响本轮。

复核与验证通过任务群聊 send 创建或复用成员，parentMemberId 指向规划 anchor；任务 owner 的 admit hook 统一申请计算名额与仓库验证屏障，验证器不再先申请第二份租约。主/子写者未停止时不会运行验证。prepared/dispatching 只查询原投递回执；unknown 或传输结果不明保留成员并暂停，不能轮换模型重发。

代码复核先运行；严重问题退回修复，其它结果再进入必做证据验证。保留 Web、backend、Android、iOS、desktop 采集器、自动测试/lint、性能基线与设备租约。验证配置由只读模型直接回复，按项目全部平台采集；不可用、降级或缺证据明确记为存疑。每项 pass 都必须引用本轮证据文件，遗漏或重复检查编号不能通过。

采集配置回执严格核对顶层字段，误回代码复核对象不会被静默当成空配置继续运行。合法空配置仍表示没有额外配置，不代表检查通过；没有实际证据仍须存疑。

重验的复核输入只复用同一确认轮次、同一提交最近一份已完成采集的独立原文和采集备注；不转交旧复核判词、汇总结论或中断报告。来源从验证库精确读取，文件须仍位于对应验证目录且校验值一致。角色准备上下文也只提供当前确认轮次每成员最新交付，不混入历史验证沉淀；明确属于其它 commit 的交付排除，无 commit 的交付标为待核实声称，不能当当前提交的证据。旧判定和报告仍在群聊、面板与证据库保留，不能成为本次结论依据；本次仍须独立复核并重新采集验证。

结论按 fail > doubt > pass 聚合。相同 workspace 与 confirmedAt 下的复核/验证 fail 共用自动退回上限（maxReviewReturns，0 表示不自动退回）。未超限的 fail 切回 executing 并发布 task.fix_requested，由编排 owner 重新申请写资源；验证器不会直接启动写入者。doubt、超限或停止不明暂停；pass 进入 awaiting_acceptance，Git 收尾由 WP-115 统一任务命令核对用户授权后处理。

验证过程中 HEAD 或工作树变化会将本轮全部判定作废为 doubt；验收 owner 仍须在「通过」时再次核对已验证 commit 与工作树。重启把未完成的任务验证标为存疑并暂停，先核对原生状态和资源，绝不回放旧运行。正常完成的辅助成员保持 idle，供缓存到期前压缩与再次接手；失败候选才终结会话，租约由宿主回合结束释放。辅助会话保留原生历史，权限策略在结束与重启后仍保持只读；任务辅助会话不允许直接执行 shell，命令由证据采集器负责。

代码复核与验证结果经 taskArtifacts.record 保存来源和证据索引，群聊 owner 负责 publish 与重启补发；原生问答与辅助成员均保留在同一任务 tab。准入中断或停止已暂停时，只要确认轮次和会话仍匹配，已完成报告仍保存为历史沉淀，不恢复阶段或继续派发；确认已替代则不混入新轮。面板通过沉淀查看旧报告、日志与图片并定位群聊源输出。报告及文件在 $VIBE_HOME/verify/tasks/<verification id>/，记录 workspaceId、confirmedAt 与 commitHash。证据读取核对真实路径，拒绝越出证据根目录。

新增 RPC：vibe.verify.task.get({workspaceId, verificationId?})、vibe.verify.task.rerun({workspaceId})。前者只读，后者仅在本轮确认仍有效且当前无验证运行时接受。共享 createTaskVerificationCommands(db).list(workspaceId, confirmedAt) 提供本轮验证 commit/结论，Git owner 只能使用最新已结束的 pass。

模型不可用、额度或登录失败在旧原生会话确认停止后按冻结候选接续，并记录实际 provider/model、candidateIndex 与前序会话；普通测试/工具失败不轮换。上下文冷交接会暂停并要求重新验证，避免把跨代码状态的证据拼为通过。

用户已准入的实际角色选择会用于后续复核与验证，沿其冻结快照和实际候选继续，不重读可变的预设或改写确认默认。复核与验证成员配置包含当前 confirmedAt 和 commit，跨确认或提交时由宿主配置匹配隔离旧 provider 私有上下文。显式重验遇到已有失败或明确取消收口证据的叶子成员时创建新成员；同确认轮次记录接续关系，跨确认轮次不串旧链。已 closed 或缺少正常完成结束证据的 ended 成员也新建，不复活旧成员。停止结果不明不能据此重建成员。同范围正常完成和空闲成员仍可复用提示缓存。

验证命令：

```bash
npm test -- test/task-pipeline.test.ts test/task-resources.test.ts test/launcher.test.ts
npm run typecheck
```

真实模型、Web/Android 与隔离 daemon 的验收证据由 WP-112 总报告记录；单测使用可注入 runner/模型/采集器，不冒充真实模型或设备实测。
