# fork-fix-core-gaps

> In myVibeBoard (Paseo fork), when the host/plugin API lacks a capability, add it in core instead of accepting a plugin-side limitation（类型 feedback，最后修改 2026-10-21T09:58:05.037Z）

When a plugin feature is limited because Paseo's plugin API/host doesn't expose something (e.g. agent rename, Markdown renderer), add the capability with a small `[core]` change rather than reporting "Paseo doesn't support it" as a known limitation.

**Why:** User (2026-10-21): "不是已经是fork的源码吗？这种情况就应该修改源码了". The repo is a fork precisely so core can be changed.

**How to apply:** In subagent briefs and reviews, treat "host API lacks X" as a [core] task (small, separate `[core]` commit, protocol back-compat + feature gating per CLAUDE.md), not as a residual limitation. Only push back if the core change is large — then present the size to the user.
