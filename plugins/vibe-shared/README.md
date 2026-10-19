# vibe-shared

Single source of truth for myVibeBoard (docs/vibe/ARCHITECTURE.md, WP-01). Not a Paseo plugin:
`scripts/vibe/sync-shared.mjs` copies it into the plugins (the plugin compiler cannot import
outside a plugin directory).

- `contract/` - runtime-neutral (client, server, App): zod models, enums, card/session state
  machines, event types, HLC format, sort keys, collector/Runner interfaces, sync table spec.
- `db/` - server only, `node:sqlite` (Node >= 22): connection (`openVibeDb`), per-owner migrations
  (`migrateOwner`), command layer (`createVibeStore`), event bus (`publishEvent`,
  `createEventConsumer`).

## Rules

- DB path: `$VIBE_HOME/vibe.db` (default `~/.vibe`). Tests and dev daemons must set `VIBE_HOME`.
- Only the owner runs DDL for its tables: `migrateOwner(db, "core" | "verify" | "context" |
"scheduler" | "stats" | "maintain")` (dependent owners migrate `core` first; concurrent callers
  are safe).
- Writes to project/card/card_event/agent_session/preset/tag/plan_version go through
  `createVibeStore(db)` only. Each command is one `BEGIN IMMEDIATE` transaction that validates the
  state machine, stamps HLCs (`updated_hlc` + field-level `sync_meta`, tombstones for deletes) and
  publishes `vibe_event` rows. Other owners' tables use plain SQL, plus `publishEvent` for their
  events (`verification.*`, `maintenance.triggered`).
- Events are at-least-once per consumer name (cursor advances after the handler resolves);
  handlers must be idempotent. Producers can pass `dedupeKey` for idempotent publishing.
- Card moves: `store.cards.move(id, { to, actor })` - see `contract/state-machine.ts`
  (`todo -> in_progress` only via `store.cards.dispatch`).

## Commands

    npm ci && npm run typecheck && npm test

## Consuming (scripts/vibe/sync-shared.mjs)

`db/` imports `../contract/...`, so a consumer that uses `db` must copy `contract` next to it:

    "vibe": { "shared": { "shared": ["contract"], "server": ["contract", "db"] } }

(client code imports `shared/vibe/contract`, server code imports `server/vibe/{contract,db}`).
`npm run vibe:sync-shared:check` must pass in every WP.
