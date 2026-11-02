# parallel-work-packages

> 用户要求多排并行工作包加快进度，而不是调优先级；Codex 长任务要明确要求做完再停（类型 feedback）

2026-10-29 用户：「不需要修改优先级，而是应该多多排并行任务，加快进度，不然你这样效率太低了」。

**Why:** 串行一个包一个包做太慢；Claude 的瓶颈是审核与补测，Codex 可以同时开多路。

**How to apply:** 依赖已满足的包同时开工，每包独立 worktree（D:\devRepoCaches\worktrees）+ 简报里写明「文件范围」和迁移版本号分配，避免互相覆盖；用 Start-Process 后台起多路 Codex，并各挂一个 until-grep 的后台等待以便收到完成通知。Codex 有时只做一部分就写报告收工，简报要写「全部做完再停」，续跑用 `codex exec resume <session id>`（多路并行时不要用 `--last`）。相关：[[codex-launch-windows]]、[[heavy-tasks-via-guard]]
