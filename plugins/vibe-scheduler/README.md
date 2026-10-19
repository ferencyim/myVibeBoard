# vibe-scheduler

myVibeBoard resource scheduler (WP-34). Supported Paseo versions: see `requirements.paseo` in
`paseo-plugin.json`.

```bash
npm ci && npm run typecheck && npm test
VIBE_E2E_SAMPLE=1 npx vitest run test/resources.test.ts   # one real machine sample, printed
```

## What it does

- **Admission** (`server/scheduler.ts`): every `tickSeconds` it looks at `todo` cards in order of
  priority, then time since the card entered todo, and publishes `scheduler.admitted
  {cardId, presetId, provider, port, deviceIds}` for those that may start. vibe-board's admission
  consumer (`vibe-board/server/dispatch/admission.ts`) dispatches them; a failure comes back as
  `scheduler.dispatch_failed` and the slot is released (retry with back-off, then give up after
  `maxAdmitAttempts`). The UI's "Dispatch now" button still dispatches directly and skips the
  scheduler.
- **Limits**: global `globalLimit`, per provider `providerLimits`, per project
  `project.concurrencyLimit`, and the device pool (exclusive `device_lease`; a card whose preset
  `runtimeEnv` needs an emulator/simulator/board waits while none is free. If no device of that kind
  is registered, the pool does not gate). The smallest wins.
- **Quota** (`providers.listUsage()`, cached 60 s): remaining <= `quotaTightPct` = tight, <=
  `quotaExhaustedPct` = exhausted. Tight providers only admit cards at `tightMinPriority` or higher
  (high priority gets the strong agent first); exhausted ones admit nothing. Changes publish
  `scheduler.quota_low` so the master agent can reassign or wait for `resetsAt`.
- **Memory gate**: used memory >= `memoryThreshold` pauses admission (`scheduler.paused` with the
  heaviest sessions; resumes 5 points below, `scheduler.resumed`). `status.paused` /
  `canStartEmulator()` tell emulator launchers to hold off.
- **Resource samples**: every `sampleSeconds`, `resource_sample` gets cpu and mem (0-1),
  `per_session_json` (session id -> `{memBytes,cpu,procs,cardKey}`) and `device_pool_json`
  (`{busy,total,devices:{name:{kind,leased,cardId}}}`); disk is in `scheduler.status`.
  Per-session usage = processes whose command line mentions the session's worktree (else project
  dir) plus their descendants (best effort: an agent CLI started with only a cwd is not seen).
- **Ports**: one dev-server port per admitted card from `devPortBase..+devPortSpan`, checked free
  on the machine and persisted in `$VIBE_HOME/scheduler/ports.json`; released with the card. The
  admission consumer adds the port to the dispatch brief.
- **Sub-agent selection** (`server/select.ts`, pure): `selectAgent(profiles, task, ctx)` ranks
  agents by quota, machine pressure, capability table (`agentProfiles` setting over built-in
  defaults), tag/platform strengths, tier vs size/priority, track record parsed from
  `<repo>/.vibe/workers/<agent>/MEMORY.md` (bullets with a check/cross or success/fail marker and
  `#tags`) and current load; a user pre-selection always wins. Exposed as RPC
  `scheduler.selectAgent`; the file has no imports so it can be copied into other plugins.

## Devices and leases

`vibe-shared/db/leases.ts` (`createDeviceLeases`) implements `acquire(request)` ->
`{leaseId, deviceId, serial?, avd?, release()}` on `device` / `device_lease` and is shared with
vibe-verify. Lease owner markers (`session_id`): `scheduler:<cardId>`, `verify:<verificationId>`.
Register devices with RPC `scheduler.registerDevice {kind,name,serial?,avd?}`.

## RPCs

`scheduler.status`, `scheduler.selectAgent`, `scheduler.devices`, `scheduler.registerDevice`,
`scheduler.removeDevice`.
