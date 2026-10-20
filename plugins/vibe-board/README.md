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

## Phone sync and offline replies (WP-41)

Server side of the App's offline mode; code in `server/sync/`, contracts in `shared/rpc/sync.ts`.
Call them with `client.invokePluginRpc("vibe-board", name, input)`.

- `vibe.sync.exchange` - request/response are vibe-shared's `ExchangeRequest` / `ExchangeResponse`
  (`server/vibe/sync/exchange.ts`; the App uses the generated copy and `ClientSync`). Loop while
  `more`; `snapshot: true` means clear the local synced state first; `rejected[]` lists writes the
  server refused (reason `column_locked`, `read_only`, ...) - the response already carries the
  authoritative values, nothing else to do. `serverNow` of an ok response is the "as of hh:mm" time
  for the read-only tables.
- Values are raw SQLite cells of `vibe.db` (text / integer / null; `*_json` stay JSON text, flags are
  0/1), row id = pk joined with ":" (`card_tag`: `<cardId>:<tagId>`; membership rows use the
  existence marker field `__row`). Phone-writable tables: project (edit only), card, card_event
  (new `note` events only), preset, tag, card_tag, maintenance_rule (edit only); a new card needs
  `project_id`, `title`, `column`, `sort_key`. Read-only snapshot + increments: agent_session,
  plan_version, git_snapshot, verification, verification_item, evidence_file (without file paths),
  maintenance_run. `key`/`number` of a new card are assigned by the daemon and are not synced.
- Accepted phone writes go through `createVibeStore` (state machine, HLC stamping, `vibe_event`
  such as `card.created` / `card.moved` / `card.updated`), so other plugins see them. The phone may
  only move cards draft <-> todo, delete draft cards without sessions, and never touch built-in tags.
- `vibe.reply.check` / `vibe.reply.send` - for `PendingReplyQueue.flush`: `check` returns
  `pending | answered | gone`; `send` re-verifies, answers the Paseo permission/question request
  (once per reply id) and fails with `[stale]` if the question closed meanwhile or `[unavailable]`
  if the daemon handle is not ready (retry).
- The exchange log lives in `sync_field` / `sync_tomb` (core migration 2, cursor = server arrival
  seq); business tables stay the source of truth and are reconciled on every exchange.

## Stall watchdog and failover (WP-82 / WP-84)

- **Stall watchdog** (`server/lifecycle/watchdog.ts`): every 30 s, working/starting sessions of
  worker, verifier, reviewer and planner roles are compared with the timestamp of the agent's newest
  timeline item; no output for `stallMinutes` (default 10; `stallProviderMinutes` such as
  `claude=15,codex=8` overrides per provider) -> `sessions.markStalled` (event `session.stalled`,
  card event, red "可能卡住" card badge, phone push "Agent stalled"). Output, a new turn, a permission
  request or the session ending clears it (`session.unstalled`). `waiting` sessions are never listed.
  `stallAutoInterruptMinutes > 0` interrupts a stalled agent once and sends a "continue" prompt.
- **Failover** (`server/dispatch/reassign.ts`, classifier `server/lifecycle/error-class.ts`): a
  worker whose turn fails with a quota / login / model / provider-unavailable error (pattern table,
  add rules there) continues on the next preset of the failed preset's `fallbackPresetIds`, in the
  same worktree. Claude <-> Codex sessions are converted to a native session (txcript, via the
  switch-provider plugin's folder, `dispatch/convert.ts`); any other pair, or a failed conversion,
  gets the dispatch brief plus a Markdown transcript in `<worktree>/.vibe/sessions/`. The swap is
  `sessions.recordReassign` (card timeline `switch_agent` + `failover` events, push "Agent switched").
  No fallback left -> the session stays in `error` (push "Agent failed"). A dispatch whose agent
  cannot even start walks the same chain. Switch: setting `failoverEnabled`; chain editor: Manage ->
  presets -> "失败时改派到".
