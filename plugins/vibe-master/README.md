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
- **Wake-ups** come from the `vibe_event` bus only (`server/wake`): `card.moved -> done` consolidates project
  memory; scheduler and maintenance signals raise reminders. Since WP-105 the master takes **no part in the card
  flow**: no draft review, no dispatch recommendation, no advice on worker questions, no acceptance. One serial
  queue; jobs that cannot run (no daemon handle yet, quota exhausted) are parked and resumed on the next handle or
  switch. On start, recently finished cards without a memory update are swept.
- **Subscription switch** (RPC `master.switch`, screen, command palette, settings): starts the new
  agent first, then retires the old one (`session.switched` event); the queue and the board carry on
  unchanged, so the same cards are processed. The choice is kept in `<VIBE_HOME>/master/state.json`.
  "highest reasoning" = the last thinking option of the catalog.
- **Permission mode** (WP-71, setting `permissionMode`, RPC `master.permission`, status screen, command palette): the
  master's (planning sessions run read-only on their own preset, see below). `auto` (default) = the provider's own automatic mode taken from the Paseo
  mode catalog (`providers.listModes`): Claude `auto` (classifier), Codex `auto-review` (older Codex without it: `auto`,
  Default Permissions, still below Full Access); a provider without an automatic mode keeps its own default. Anything
  else is a concrete modeId of the provider (a mode the provider lacks falls back to auto). The UI shows the concrete
  mode in effect. A manual switch is kept in `state.json` and wins over the settings default until set back
  (`settings`). The plugin API has no in-place mode change, so a running master is replaced like a subscription switch
  (new agent first, then the old one retires, same cards continue). The hook `agent.permission_requested` approves **only** calls of the
  `vibe-board` MCP server (Claude `mcp__vibe-board__*`, Codex `CodexMcpElicitation` with `serverName=vibe-board`) by
  the master and planners; any other request of those agents waits for the owner and raises a `master.alert`
  (`kind=permission_wait`, pushed like the others).
- **Quota**: low quota (own `listUsage` check, or `scheduler.quota_low` for the master's provider) and
  quota errors only publish a reminder: a `master.alert` bus event (`kind` quota_low|quota_error);
  `server/notify` pushes it to the phone. It never switches by itself.
  `scheduler.paused/resumed` are shown in the status.
- **Maintenance events**: `maintenance.paused` (rule paused after repeated rejections) raises a
  `master.alert` of kind `maintenance_paused` (pushed like the others); `maintenance.triggered` is only
  logged.
- **Memory** (`server/memory`): on card done the master replies with a `MemoryUpdate` (state, decisions,
  lessons, index, archive); `files.ts` writes the same marker format vibe-context reads. Budget
  enforcement stays in vibe-context.

## Card planning sessions (WP-33, reworked by WP-105, `server/planning`)

- **The plan tab of a card.** One planning session per card: a separate Paseo agent (`role=planner`,
  `card.plan_session_id`) on the card's **planning model** (`card.planner_preset_id`, a preset the owner picks), in the
  project repository in read-only mode (claude `plan`, codex `read-only`, else the provider's read-only mode). Its system
  prompt is the registered `master.plan.system` (reply format in the fixed suffix), not the master rules.
- **The channel is the card**: plan-thread `chat` events (`thread: "plan"`). 制定方案 is an owner message with
  `action: "make_plan"`: when the card has a **scout model** (`card.scout_preset_id`) a read-only scout explores first
  (`master.plan.explore`), then the planner gets the full context (`master.plan.start`). Later owner messages are
  answers or change requests (`master.plan.turn`). The planner may ask the scout model for research (max 3 questions,
  `maxResearchRounds` rounds). "Unanswered" is derived from `answers`, so restarts and late offline arrivals work.
- **Write-back** (`cards.setPlan`): the card's single plan is overwritten (`plan_json`, a `plan_updated` note for the
  timeline); acceptance criteria are written directly unless the owner edited them since the model last wrote them
  (`model_acceptance`), then they become a pending proposal in the plan chat. Title/description changes are proposals.
- **Switching the planning model** archives the old session; the new one starts with the plan conversation, the plan
  and the criteria (all on the card). The session ends when the card is done or archived. No hand-off file: the
  executor's brief reads the plan from the card.

## RPCs

`master.status` (queue, session, target, switch history, providers with models/quota),
`master.switch {provider, model?, thinking? ("max")}`, `master.permission {mode: auto|<modeId>|settings}`,
`master.wake {card, reason: "card_done"}`.

## Notes for other work packages

- The plugin API hands out the daemon handle only inside hooks and RPC calls, so the master learns it
  from `agent.*`/`workspace.created` hooks or any `master.*` RPC (the UI polls `master.status`). Until
  then jobs wait in the queue.
- Memory: plugins cannot import vibe-context, so `server/memory/files.ts` duplicates the entry
  format. Proposal: move the memory core into `vibe-shared` and use the budgeted store here.

