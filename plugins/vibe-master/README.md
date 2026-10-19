# vibe-master

myVibeBoard master agent (WP-32). Supported Paseo versions: see `requirements.paseo` in
`paseo-plugin.json`. Rules for the agent itself: `skills/vibe-master/SKILL.md` (single source;
`npm run gen:rules` regenerates `server/master/rules.generated.ts`, a test fails when stale).

```bash
npm ci && npm run typecheck && npm test
```

## What it does

- **One long-lived master agent** (a normal Paseo agent, `VIBE_ROLE=master`, recorded in
  `agent_session` with `role=master`, no card). Default Claude Opus (the "opus" model of the provider
  catalog, configurable); the cwd is an empty scratch directory (`<VIBE_HOME>/master/workspace`).
  The static rules are the system prompt; the wake message is a deterministic per-project block (tags,
  presets, open cards) followed by the dynamic card/quota part, for prefix-cache hits.
- **Wake-ups** come from the `vibe_event` bus only (`server/wake`): a new/edited draft (`card.created`,
  `card.updated` owner fields, `card.moved -> draft`) is assessed after a 30 s quiet period (setting
  `debounceSeconds`); `card.moved -> done` consolidates project memory; `session.waiting` of a worker
  produces advice (never an answer). One serial queue; jobs that cannot run (no daemon handle yet,
  quota exhausted) are parked and resumed on the next handle or switch. On start, drafts without a
  current assessment (newest 10) and recently finished cards are swept.
- **Draft assessment** (`server/assess`): the reply is parsed and validated with zod
  (`AssessmentSchema`, one repair retry). Write-back, all through the vibe-shared command layer:
  an `evaluation` card event (`body.assessment` JSON + readable `body.text`, emits `card.assessed`),
  a **plan version whose `checks` are the verification checklist** (vibe-verify reads the latest plan
  version) and `card.suggested_preset_id`. A content hash (title, description, acceptance, tags) makes
  it idempotent; edits during the assessment drop the stale result. The master never moves a card
  (state machine) and never edits the owner's fields.
- **Sub-agent choice**: `server/select.ts` adapts presets to the scheduler's pure `selectAgent`
  (`vibe-shared/contract/select.ts`: quota + priority + tier + track record from
  `.vibe/workers/<provider>/MEMORY.md`). A recommendation on an exhausted provider (or a tight one for
  non-high priority) is replaced and explained in the comment.
- **Subscription switch** (RPC `master.switch`, screen, command palette, settings): starts the new
  agent first, then retires the old one (`session.switched` event); the queue and the board carry on
  unchanged, so the same cards are processed. The choice is kept in `<VIBE_HOME>/master/state.json`.
  "highest reasoning" = the last thinking option of the catalog.
- **Quota**: low quota (own `listUsage` check, or `scheduler.quota_low` for the master's provider) and
  quota errors only publish a reminder: a `session.error` bus event with message
  `[master:quota_low|quota_error] ...` (the event vocabulary has no dedicated alert type; the daemon's
  own push already fires when the master turn errors). It never switches by itself.
  `scheduler.paused/resumed` are shown in the status.
- **Memory** (`server/memory`): on card done the master replies with a `MemoryUpdate` (state, decisions,
  lessons, index, archive); `files.ts` writes the same marker format vibe-context reads. Budget
  enforcement stays in vibe-context.

## RPCs

`master.status` (queue, session, target, switch history, providers with models/quota),
`master.switch {provider, model?, thinking? ("max")}`, `master.wake {card, reason}`.

## Notes for other work packages

- The plugin API hands out the daemon handle only inside hooks and RPC calls, so the master learns it
  from `agent.*`/`workspace.created` hooks or any `master.*` RPC (the UI polls `master.status`). Until
  then jobs wait in the queue.
- WP-33 (planning sessions) can reuse the agent-creation pattern of `server/master/session.ts` and
  the `MasterAsk` port; planning agents are separate sessions, not this one.
- Memory: plugins cannot import vibe-context, so `server/memory/files.ts` duplicates the entry
  format. Proposal: move the memory core into `vibe-shared` and use the budgeted store here.
