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
