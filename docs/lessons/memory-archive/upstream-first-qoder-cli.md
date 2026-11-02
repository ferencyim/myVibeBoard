# upstream-first-qoder-cli

> myVibeBoard: merge upstream Paseo before each round; coding goes to Codex CLI gpt-6.1-terra medium normal speed (2026-10-29; was gpt-6.1-sol), Claude only does UI review and design; qoder dropped（类型 feedback，最后修改 2026-10-27T01:49:20.003Z）

1. Before starting any round of code changes, fetch and merge upstream getpaseo/paseo (latest stable tag) into main first (docs/vibe/FORK-WORKFLOW.md), then do the round's work.
2. Executors (user, 2026-10-26, also recorded in global ~/.claude/CLAUDE.md): apart from UI fault-finding and design, concrete tasks go to **Codex CLI, model gpt-6.1-terra (from 2026-10-29; previously gpt-6.1-sol), reasoning medium, normal speed** (`codex exec -C <worktree> -m gpt-6.1-terra -c model_reasoning_effort=medium ...`). Claude writes briefs, reviews, commits, merges. qoder was dropped earlier the same day (unreliable); Claude subagents are only a fallback with the user's OK when Codex is unavailable.
3. While an external CLI run is in flight, check it every ~30 minutes for runaway or abnormal state.

**Why:** User: "每次更新代码之前，最好先拉取paseo的源仓库更新"; "除了 UI 挑错和设计，具体任务交给 codex cli sol 6.1 medium 正常速度执行".

**How to apply:** Upstream merge is step 1 of every round. Brief Codex with the usual rules (no recursive delete, own worktree only, no git commit/push), then review its diff before merging. Earlier Codex runs on Windows hit a broken sandbox (node_repl.exe locked by the Codex desktop app); the user then authorized danger-full-access. See [[fork-fix-core-gaps]], [[daily-install-restart]].

**2026-10-29 用户：所有会话的 Codex CLI 后续一律改用 `gpt-6.1-terra`（terra 6.1），不再使用 `gpt-6.1-sol`；遇容量不足退避后续原会话，不换回 sol。**
**2026-10-29 用户（所有项目所有会话）：Codex 额度用完时，在额度重置前直接改派 Claude 子代理 Haiku 5.5（claude-haiku-5-5），搞不定再用 Sonnet 5.5（claude-sonnet-5-5），无需再问；重置后切回 Codex gpt-6.1-terra。额度以外原因不可用仍先问用户。**
