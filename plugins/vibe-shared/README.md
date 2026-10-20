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

- Sync (WP-41): `sync_field` / `sync_tomb` (core migration 2) are the phone-sync exchange log, written
  only by vibe-board's `server/sync`. `contract/sync-spec.ts` fields include the columns needed to
  create a card / card_event on a phone (`card.project_id`, `card_event.card_id/type/author_kind/author/created_at`);
  `cards.create`, `events.add`, `tags.create`, `presets.create` accept an optional replica-generated `id`.

## Round 2 additions (core migration 3, verify migration 2)

Additive and nullable; shared by the round-2 work packages.

- `card.reviewer_preset_id` (`reviewerPresetId`, synced both ways): `cards.setReviewer(id, presetId | null)`
  (validates the preset; also settable via `cards.update` / `cards.create`).
- `preset.fallback_preset_ids_json` (`fallbackPresetIds: string[] | null`, ordered failover chain) and
  `preset.role_hint` (`roleHint`, e.g. `scout` | `worker` | `reviewer`), both synced; `presets.create/update`
  accept them. Deleting a preset scrubs it from cards' reviewer and other presets' chains.
- `PlanSnapshot.files?: string[]` - globs the plan touches (scheduler conflict check).
- `agent_session.stalled_since`, `complexity` (`short|multi|long`), `reassigned_from_session_id`
  (`last_activity_at` already existed). **No `stalled` session state**: stalling is a marker, so the
  session state machine and every existing consumer of `state` are unchanged; the marker is cleared by
  activity or when the session ends/errors.
  Commands: `sessions.touchActivity(id, at?)`, `markStalled(id, {since?, idleMs?})`, `clearStalled(id)`,
  `setComplexity(id, complexity | null)`, `recordReassign({fromSessionId, agentId, provider, reason, ...})`
  (one transaction: ends the old session with outcome `reassigned`, starts the replacement, sets
  `card.preset_id`, writes a `switch_agent` card event).
- Events: `session.stalled`, `session.unstalled`, `session.reassigned`, `session.complexity_changed`,
  `review.started`, `review.finished` (`verdict: pass|issues|severe`, `issues: string[]`),
  `scout.started`, `scout.finished`.
- `verification.kind` / `verification_item.kind`: `check` (default) | `review`.

## Commands

    npm ci && npm run typecheck && npm test

## Consuming (scripts/vibe/sync-shared.mjs)

`db/` imports `../contract/...`, so a consumer that uses `db` must copy `contract` next to it:

    "vibe": { "shared": { "shared": ["contract"], "server": ["contract", "db"] } }

(client code imports `shared/vibe/contract`, server code imports `server/vibe/{contract,db}`).
`npm run vibe:sync-shared:check` must pass in every WP.
