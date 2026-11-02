# AGENTS.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Antigravity, and Muse Code.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## myVibeBoard 硬规则（先读）

通用规则（git 与 worktree、需求、子代理、密钥、SESSION.md）见全局 AGENTS.md（`C:\Users\feren\.codex\AGENTS.md`）。本文件只放每次都要知道的规则和索引。旧注释中的 CLAUDE.md 指现在的 AGENTS.md 和文档库。

**这是 `getpaseo/paseo` 的分叉**

- 自研放 `plugins/`；改 `packages/` 要小且单独提交，提交信息以 `[core]` 开头。
- 宿主或插件接口缺能力时，加一个小的 `[core]` 改动，不要报成“Paseo 不支持”的已知限制；只有核心改动很大时才把体量报给用户。见 [working-with-user](docs/lessons/working-with-user.md)。
- 每轮改代码前先合上游最新稳定 tag，再做本轮工作；绝不把上游 tag 推到 origin。步骤见 `docs/vibe/FORK-WORKFLOW.md`。
- 本文件和根 `CLAUDE.md` 与上游结构不同：合上游遇到冲突时保留本结构（`AGENTS.md` 是实体，`CLAUDE.md` 只引用它），把上游的改动移植到本文件、`docs/README.md` 或 `docs/platform-gating.md`。
- GitHub Actions 关闭。全量验证走本机。
- GitHub 仓库是公开的（公开项目的分叉，2026-11-02 核实，用户同意把这次记忆迁移推上去）。写进仓库的内容都会公开：不写口令、密钥、生产地址和其他私有项目的细节。

**验收**

- 完成标准是用户提的每一条需求都在已装的日用桌面版（`D:\Programs\myVibeBoard`）里经 CDP 实测通过，逐条列出通过或失败；单测全绿不算完成。装机后核对安装脚本退出码，确认改动文件确实落到安装目录。没有后端状态时界面也要完整。方法见 [ops](docs/lessons/ops.md)。
- 用户只描述现状（“现在只显示图标”）而没说要改时，先问一次是不是问题，不写进 PRODUCT-REQUIREMENTS.md，也不实现。

**本机资源与依赖**

- 构建、打包、APK、全量套件、模拟器一律经 guard 后台排队：`bash D:/devRepo/ci-dashboard/queue/win-heavy-guard.sh run --owner MYVIBE:<名称> --priority 2 --mem-gb 4 -- bash -lc "<命令>"`（`status` 看队列）。单个测试文件不用排队。
- 依赖变更只在无 junction 的主检出做，且先确认没有别的会话在用；worktree 里只跑 lint、typecheck、测试，绝不跑 `npm install`。2026-10-29 曾因此清空主目录约 139 个包。
- 见到 guard 阈值等共用配置与仓库不一致时先问，不要当事故恢复（可能是用户自己改的）。

**日用环境**

- 插件更新带 `vibe.db` 迁移时：先 `VACUUM INTO` 备份，确认没有 agent 在跑，再整体重启守护进程，不要逐个 `plugin reload`。没有迁移才可以 reload。
- 打开资源中枢“接管全机重任务”前，先用真实锁目录形态回归测试并通知其他会话，异常的退出步骤见 [ops](docs/lessons/ops.md)。

**协作**

- 依赖已满足的工作包同时开工，每包独立 worktree，简报写明文件范围和迁移版本号分配，并写“全部做完再停”。
- 其他会话请求“冻结本机重任务、不推送”时，本项目开发、构建、测试照常（重任务仍经 guard），只不向对方列出的仓库推送；会直接改变对方行为的动作（打开中枢接管、改共用配置）才推迟并告知对方。拿不准问用户。
- 执行者和模型按全局 AGENTS.md 的现行约定；实测用的 agent、修测试、查日志选便宜够用的模型。沙箱内 Codex 跑不了测试和格式化，见 [ops](docs/lessons/ops.md)。

**索引**：[ops](docs/lessons/ops.md)（装机、中枢、依赖事故、Codex 启动）；[working-with-user](docs/lessons/working-with-user.md)（用户原话和场景）；`docs/vibe/ENGINEERING-LESSONS.md`（工作包提炼的工程经验）；[memory-archive](docs/lessons/memory-archive/README.md)（2026-11-02 迁入的记忆原文，只读）。

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** At the start of non-trivial work, read the index in [docs/README.md](docs/README.md) and skim anything relevant. Fork design docs are in `docs/vibe/`; project lessons in [docs/lessons/](docs/lessons/).

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with Biome
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

When Mo requests an APK, use `npm run build:apk:arm64` for an ARM64 build: writes `artifacts/paseo-dogfood-arm64.apk` with diagnostics without starting a device; `npm run build:apk` builds all four Android architectures.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Release branches

When the user says "this goes to next", create or
retarget the PR to `next` and preserve that destination through delivery. Follow
[release branch discipline](docs/release.md#release-branch-discipline) for creating
and updating `next`, integrating it after a release, and releasing a hotfix from a tag.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, run it through win-heavy-guard (see the fork section). GitHub Actions stays off on this fork.
- Add tests to existing suites and reuse their npm scripts and CI jobs instead of creating feature-specific ones.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/app/src/components/message.tsx`
  - `npm run format:files -- AGENTS.md packages/app/src/components/message.tsx`
- **The protocol stays backward-compatible. Features don't have to.** Read [docs/protocol-compatibility.md](docs/protocol-compatibility.md) before touching `packages/protocol`. The short version:
  - **Protocol contract (always):** an old client parses messages from a new daemon, and a new daemon parses messages from an old client. New fields are optional; never narrow, never remove, never require. Wire schemas stay pure — no `.transform()`, `.catch()`, or `.preprocess()`.
  - **Feature contract (per-feature):** gate the capability once on `server_info.features.*`, then run the feature or tell the user to update the host. No fallback paths, no defensive branches.
  - **Every shim is tagged.** `// COMPAT(name): added in vX, remove after <date>` at the site that has to be deleted. `rg "COMPAT\("` is the cleanup backlog; untagged back-compat is permanent by accident.
  - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

## Platform gating

The app runs on iOS, Android, web (browser), and web (Electron desktop). Code is cross-platform by default; gate only when you must. Before adding a platform check, hover UI, or `.web`/`.native`/`.electron` file, read [docs/platform-gating.md](docs/platform-gating.md).

## Debugging

Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log
