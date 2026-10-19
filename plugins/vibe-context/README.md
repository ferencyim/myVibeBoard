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
