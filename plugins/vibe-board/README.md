# vibe-board

myVibeBoard's kanban board plugin (docs/vibe/ARCHITECTURE.md, WP-10 server side). Derived from the
community Tasks plugin (see `UPSTREAM.md`, Apache-2.0 `LICENSE`).

- Five columns: draft, todo, in_progress, verifying, done. Cards carry tags, priority, acceptance
  criteria, reference images, `needsEvidence`, a preset, a timeline of events and plan versions.
- Data lives in the shared `$VIBE_HOME/vibe.db` (default `~/.vibe`), written only through the
  vibe-shared command layer (state machine, HLC stamping, `vibe_event` bus).
- RPC contract: `shared/rpc/index.ts` (`vibe.*` names; one object per RPC in `VIBE_BOARD_RPCS`).
- Agents: MCP server `vibe-board` (tools `vibe_projects|list|show|create|update|comment|attach`) and
  the `vibe-board` CLI (`vibe-board help`). Both are injected into agents by the plugin; they cannot
  move cards between columns.
- Dispatch and lifecycle (todo -> in_progress -> verifying) are WP-12. The board UI (WP-11/14)
  lives in `client/`: `board/` (tabs, five columns, drag, Move-to menu), `detail/` (card detail),
  `presets/` (pickers, quota from `providers.listUsage()`, manage dialog), `common/`. Pure logic is
  in `board/logic.ts` and `presets/logic.ts` (unit tested).

## Development

    npm install
    npm run typecheck && npm test
    pwsh scripts/vibe/dev-daemon.ps1 -Plugin plugins/vibe-board   # from the repo root

`shared/vibe` and `server/vibe` are generated copies of `plugins/vibe-shared` (`npm run
vibe:sync-shared` at the repo root); do not edit them.
