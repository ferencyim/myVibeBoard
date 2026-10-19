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
