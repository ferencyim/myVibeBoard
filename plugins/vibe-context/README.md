# vibe-context

myVibeBoard plugin. Supported Paseo versions: see `requirements.paseo` in `paseo-plugin.json`.

```bash
npm install   # first time: creates package-lock.json (commit it)
npm run typecheck && npm test
```

## server/memory (WP-30)

File-backed project memory under `<repo>/.vibe/` (entries carry `id/created/touched/tag` in a
`<!-- vibe:entry ... -->` marker line). Per-file token budget = share of the model context window;
overflow moves the least recently touched entries to `*_ARCHIVE.md` (deterministic, no model).
Only the master actor writes project memory. `memory_entry` is a derived index: files win, rebuild
with `rebuildMemoryIndex`. Entry point: `createMemoryStore` in `server/memory/index.ts`.

## server/inject (WP-31)

`agent.create` hook that injects project context (user directives -> project instructions ->
memory; the task brief follows in the prompt) into agents whose cwd contains `.vibe/`:

| provider | channel |
| --- | --- |
| claude | `systemPrompt` (block prepended once, marker `vibe:context`) |
| codex | generated `AGENTS.override.md` (AGENTS.md text + block), git-excluded; verified against a real Codex |
| kimi, deepseek | marked block in `AGENTS.md`; tracked file: `skip-worktree`, only in a linked worktree; untracked: git-excluded |

Unlisted providers and non-`.vibe` directories are left alone; failures never block agent start.
The dispatch brief (vibe-board `server/dispatch/brief.ts`) only points at `.vibe/` files and
declares them authoritative and read-only. Hook order between plugins is not guaranteed, so the
block is prepended to `systemPrompt` to stay the stable prefix.

## server/compaction (WP-35)

Compacts idle sessions shortly before their prompt cache expires. Time only: a session that is
`idle` (never `waiting` on an approval) and whose `agent_session.cache_expires_at` is less than the
margin away (3 min for a 1 h TTL, 1 min for 5 min) is handled once per idle period. The agent first
writes its progress to `.vibe/sessions/<card id>.md`; then `/compact` is sent (claude, codex) and the
project context block (`server/inject`) is re-injected. CLIs without `/compact` get a handoff: a new
agent cold-starts from the session .md and memory files, the old session ends. A card
`compaction` event is recorded (lifecycle of vibe-board records completed compactions found in the
turn timeline; this module adds one only when that did not happen, strategy `handoff` for handoffs).

- Expiry is `last turn end + TTL`. TTL per provider comes from the `compaction` plugin settings
  (`ttlSeconds`, e.g. `{"claude": 3600}` for a subscription, `300` for an API key); defaults claude
  3600, codex 300. Statusline-reported TTLs are not read by the daemon yet.
- `detectNativeIdleCompaction` (`native.ts`, replaceable via `CompactionOptions.detectNative`)
  probes the local `claude --help` / `--version` once at start; if Claude Code compacts idle
  sessions itself, claude is skipped. `NATIVE_MIN_VERSION` is null until the release is confirmed.
- A compaction turn that stops on an approval waits up to 10 min for the user, then is retried later.

## server/complexity (WP-83)

Conversation complexity -> context strategy. `classifyComplexity` (pure, `classify.ts`) maps
`{turns, cacheRead, turnPeaks}` to `short` / `multi` / `long`; the scheduler stores the result with
`sessions.setComplexity` after each turn and on every tick. The change event
`session.complexity_changed` comes from the command layer; the card timeline reads it (or the
session's `complexity`), this module writes no extra note.

- **Turns are Paseo agent turns**, not model calls: the scheduler records a window
  (turn_started .. turn_ended) per effective turn, so a turn with 30 model calls is one turn.
  Turns a plugin starts (our compaction/handoff turns while the flow is busy, and turns announced
  with a `system-turns` marker, which is only peeked at, not consumed) are not counted. The
  marker check is best effort: vibe-board's lifecycle consumes the marker and hook order is not
  guaranteed.
- **cacheRead** is summed over vibe-stats' `usage_event` rows of the agent's CLI session ids
  (`CompactionHost.cliSessionIds`: persistence.sessionId / nativeHandle / runtimeInfo.sessionId).
  A turn's **context** is the largest (input + cacheRead + cacheWrite) of the calls inside its
  window. `usage.ts` is read-only and tolerant of a missing table.
- Default rules (settings group `complexity`): short <= 3 turns, multi 4-14, long = 15+ turns, or
  summed cacheRead >= 1,000,000, or >= 25% of turns with peak context >= 177,047 tokens.
- **Persistence** (`state.ts`, `vibe_meta` key `context:complexity:<session id>`): turn windows,
  compaction baseline, early-compaction count, inherited floor; survives daemon restarts. After a
  compaction only turns and usage after it count.
- short: no extra action. multi: (re-)injection after a compaction or in a handoff prompt inlines
  at most `tightMemoryTokens` (1000) of memory, larger files become pointers; the same budget is
  used by the `agent.create` injection for agents in a directory whose session is multi/long
  (`vibe_meta` key `context:tight:<cwd>`, `budgetFor` option). long: additionally compacted at the
  next idle tick even if the cache is not near expiry (`earlyCompactLong`), merged with the TTL
  trigger (one compaction per idle period). Providers without `/compact`, or a session that is long
  again after `handoffAfterCompactions` (2) early compactions, are handed over to a new session.
- A handoff session inherits the complexity (long as multi, since its context is fresh), the
  early-compaction count, and starts counting turns from zero.
- `complexity.enabled=false` turns the whole policy off (TTL behaviour only).
