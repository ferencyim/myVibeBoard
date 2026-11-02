# codex-launch-windows

> 本机后台启动 Codex CLI 的方式与不提权沙箱的限制（pwsh、stdin、spawn EPERM）（类型 reference，最后修改 2026-10-29T09:54:47.440Z）

本机 `~/.codex/config.toml` 为 `[windows] sandbox = "unelevated"`（2026-10-29 为避开 elevated 刷新 ACL 与 node_repl.exe 冲突而改）。

- 不提权沙箱运行不了商店版 pwsh（WindowsApps 下的 MSIX），命令全报 `CreateProcessAsUserW failed: 5`。2026-10-29 已装 MSI 版 PowerShell 7（`C:\Program Files\PowerShell\7`，系统 PATH 优先），问题已解决。后台启动前把 PATH 从注册表重载（Machine + User），否则当前进程还是旧 PATH。
- 后台运行时 `codex exec` 会等 stdin，不关就卡在 "Reading additional input from stdin"。用 PowerShell：`$brief | codex exec ... -`。PowerShell 不支持 `< file`。
- 沙箱内 node 启动子进程（esbuild → vitest、oxfmt 格式化）报 `spawn EPERM`，文件 ACL 正常，加 `--add-dir` 也无效。Codex 只能写代码和跑 typecheck/lint；测试与格式化由 Claude 在沙箱外补跑，再把失败细节交回 Codex。
- `packages/app/src/plugins/evaluate.test.ts` 在 main 上也报 `Cannot find module './ImportMetaRegistry'`，是既有环境问题。
- 日志里 `hook: PreToolUse Failed` 是 Paseo 终端活动 hook，非 Paseo 终端下无影响。

相关：[[upstream-first-qoder-cli]]
