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

## Default models (WP-108, core migration 9)

- `contract/model-roles.ts`: the seven model jobs (`MODEL_ROLES`), the card field of each (`CARD_MODEL_FIELD`) and
  `resolveModel(role, card, project, global, exists)` = card pick, else `project.defaultPresets[role]`, else the global
  default. Scout and reviewer are skippable: an empty card pick means "do not". Every plugin resolves through it.
- `project.default_presets_json` (`defaultPresets`, synced) replaces `default_preset_id` (moved to `worker`, column dropped).
  The global level is `store.modelDefaults.{global, setGlobal}` (`vibe_meta['models.defaults']`, not synced).
  `cards.create` prefills the jobs the caller left `undefined`; `presets.delete` also clears both default levels.
- `card.plan_reviewer_preset_id`, `card.verifier_preset_id`, `card.review_seen_at` (synced), `card.review_activity_at`
  (daemon display column); `UnreadTab` / `ChatThread` gain `review`, `RoleHint` gains `verifier`.

## Commands

    npm ci && npm run typecheck && npm test

## Consuming (scripts/vibe/sync-shared.mjs)

`db/` imports `../contract/...`, so a consumer that uses `db` must copy `contract` next to it:

    "vibe": { "shared": { "shared": ["contract"], "server": ["contract", "db"] } }

(client code imports `shared/vibe/contract`, server code imports `server/vibe/{contract,db}`).
`npm run vibe:sync-shared:check` must pass in every WP.

## Round 3 additions (core migration 4)

- `project.projectTypes` (non-empty, no repeats; first = primary), `description`, `requirementsPath`
  (repo-relative; `isSafeRepoRelativePath` rejects absolute and `..`). `projectType` stays as
  `projectTypes[0]` for old replicas (`COMPAT(project-types)`); the command layer accepts either form.
- `preset.roleHints` (`worker|scout|reviewer`, `[]` = unspecified) replaces `roleHint`
  (`COMPAT(preset-role-hints)`, kept as `roleHints[0]`). Select presets with `roleHints.includes(...)`.
- Card events `chat` (body `ChatEventBody`) and `proposal` (body `ProposalEventBody`); author kinds
  `master|executor|reviewer|scout` added (`agent` is legacy). Commands: `cards.addChat`,
  `cards.propose` (supersedes earlier pending), `cards.acceptProposal(eventId, actor)` (applies the
  changes through `cards.update`), `cards.rejectProposal(eventId, actor)`. Proposal status lives in
  `body_json` (a field-level LWW sync field), so card events stay append-only apart from that field.
- Bus event `card.review_requested { cardId, requestedBy }`.
- `db/requirements-doc.ts`: `readRequirementsDoc` / `writeRequirementsDoc` (commits only that file via
  an injectable git Runner; refuses mid merge/rebase/cherry-pick, ignored paths and path traversal).
- Migrations may set `foreignKeysOff` (table rebuilds; `PRAGMA foreign_keys` is switched around the
  migration transaction and `foreign_key_check` runs before commit).
