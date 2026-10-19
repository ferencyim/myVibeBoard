# vibe-maintain

Automatic maintenance for myVibeBoard (docs/vibe/ARCHITECTURE.md WP-36, IMPLEMENTATION-PLAN.md M10).
Rules live in each project's `.vibe/maintenance.yml`; when a rule fires its check runs and the result
becomes a board card. Server-only plugin; it talks to the other plugins through the shared SQLite
file (`vibe.db`) and the `vibe_event` bus.

```bash
npm ci && npm run typecheck && npm test      # tests use real temporary git repositories (slow on Windows)
```

## maintenance.yml

```yaml
rules:
  - name: git-health            # the same name as a built-in rule overrides it
    enabled: true
    trigger: { kind: workload, cards_done: 10, commits_merged: 30 }   # any reached threshold fires
    # trigger: { kind: time, cron: "0 3 * * *" }                      # local time, 5 fields
    # trigger: { kind: event, path: logs/crash.log, pattern: "Exception" }  # newly appended lines only
    check: { type: git, stale_days: 14, large_file_mb: 5, outdated: true }
    agent: null                 # null = deterministic only; "claude/sonnet" = read-only sub agent on top
    output: suggest             # suggest = draft card | fix = worktree + in_progress card
    priority: low
    dedupe_key: git-health      # default: the rule name
    daily_cap: 1                # automatic runs per UTC day
```

Without a file only the built-in `git-health` rule exists (workload 10 cards / 30 commits, suggest,
low priority, cap 1/day). A broken file keeps the built-ins and shows up in `maintain.status`
(`configErrors`). Rules are mirrored into `maintenance_rule`; removing a rule from the file disables it.

## Triggers

- **workload**: per-rule counters in `work_counter` (`<ruleId>:cards|commits|tokens`). Cards: every
  `card.moved -> done` of a non-maintenance card. Commits: `git rev-list --count --no-merges --since=<counter start> <main>`
  (polled at most once a minute). Tokens: `usage_event` rows of the project's cards (needs vibe-stats).
  The counters restart when the rule fires.
- **time**: cron; fires when a scheduled minute lies after the rule's last run (restart safe).
  Paseo has no schedule API for plugins, so the cron lives here.
- **event**: polls a file; only lines appended since the last look (matching `pattern`) fire the rule.

A tick (default every 30 s, setting `tickSeconds`) evaluates all rules. `maintenance.triggered`
(`ruleId`, `runId`) is published on the bus for every run.

## Output and controls

- **suggest**: a `draft` card (`origin=maintenance`, `originRef=<ruleId>`, `dedupeKey`, priority from the
  rule, default low) whose description is the check report and whose timeline gets a `maintenance`
  event with the structured findings. The master (vibe-master) assesses drafts like any other. If the rule
  names an `agent`, a read-only sub agent receives the findings and its plan is added as a note
  (the engine flags it when `git HEAD`/`status` changed while it ran).
- **fix**: the dispatcher creates the card directly in `in_progress` and starts a worker in its own
  worktree (the vibe-shared state machine allows `maintenance` + `dispatcher`). The worker is told never
  to merge; the normal lifecycle/verification path moves it to `verifying` and only the user's pass merges.
- **dedupe**: an open (not done, not archived) maintenance card with the same dedupe key only gets a
  `recurrence` event appended.
- **daily cap**: counted per UTC day over non-skipped runs; the counters keep accumulating and the
  rule fires the next day.
- **auto pause**: a card counts as rejected when the user archives/deletes a never-started maintenance
  card or sends a fix back from `verifying`; accepting (`draft -> todo`, `done`) resets the streak.
  After `pauseAfterRejections` (default 3) the rule gets `paused_at` and `maintenance.paused` is published.
  Resume with RPC `maintain.resume`.

## Git health check (`check.type: git`)

Deterministic, no model: stale unmerged branches, merged-but-not-deleted branches, leftover worktrees
(directory gone / branch merged), uncommitted changes (main checkout and worktrees), unpushed commits
(only when a remote exists), branches that would conflict with the trunk (`git merge-tree`, git 2.38+),
large tracked files, outdated npm dependencies (`npm outdated`, set `outdated: false` to skip).
Findings are grouped per category into one card.

## Performance slow records (`check.type: perf-slow`, WP-47)

Register slow-record sources and thresholds per project; the rule runs on a cron and files what is new.

```yaml
rules:
  - name: perf-slow
    trigger: { kind: time, cron: "0 4 * * *" }
    check:
      type: perf-slow
      sources:
        - { name: api, kind: jsonl, path: logs/access.jsonl, threshold_ms: 500,
            fields: { site: route, ms: duration_ms, ts: time, method: method }, unit: ms }
        - { kind: bench-json, path: bench/result.json, threshold_ms: 50 }   # hyperfine / vitest bench / [{name, ms}]
        - { kind: mysql-slow, path: /var/log/mysql/slow.log, threshold_ms: 1000 }
        - { kind: pg-log, path: /var/log/postgresql/postgresql.log, threshold_ms: 1000 }
      repro: { command: node, args: [bench/run.js, "{site}"], runs: 3 }   # threshold_ms defaults to the source's
    output: fix        # reproduced -> worktree worker; otherwise a draft card
    agent: codex
```

- **Incremental**: per source a byte offset (bench files: mtime) is kept in `work_counter`
  (`<ruleId>:cursor:*`) and advanced only after the card exists. Rotation/truncation restarts at 0; a backlog
  over 8 MB skips the oldest part (noted in the card). Unterminated last lines/blocks wait for the next run.
- **Dedupe by call site**: route (query string dropped, ids -> `:id`), SQL fingerprint (literals -> `?`) or
  benchmark name. The card's `dedupeKey` is `perf-slow:<source>:<site>`; a site with an open card is skipped, so
  the next site gets its turn. One card per run (worst p95/threshold first), the other slow sites are listed in it.
- **Reproduce first**: `repro` runs `runs` times in the repository; median above the threshold = reproduced.
  Reproduced + `output: fix` -> in_progress card, worker prompt with the exact `.vibe/verify.json`
  `backend.perf` block to merge in. Otherwise (no `repro`, command failed, not reproducible) the card is a
  **draft** with the investigation notes (`CheckOutput.forceDraft`). The card state machine has no
  `in_progress -> draft`, so a worker that is unsure instead comments its conclusion and reports
  `PERF-INCONCLUSIVE:`; the verification then ends in `doubt` for the owner.
- **Evidence**: vibe-verify's backend collector measures `backend.perf` in the baseline worktree (before)
  and the fixed worktree (after) and writes `perf-compare.json` (see the vibe-verify README).
- Real-run note: `createFixLauncher` sets no permission mode, so a Codex worker waits for a human to approve its
  first shell command (seen in the isolated-daemon run); approve it in the app or give the agent an auto mode.
- Limits: MySQL/PostgreSQL parsers cover the stock text formats only; fingerprints are literal-stripped
  text, not a SQL parse; one reproduction command per rule (use `{site}` to parametrise it).

Checks may also return `dedupeKey`, `instructions`, `acceptance`, `needsEvidence`, `forceDraft` and `commit`
(called after the card exists); `CheckContext` offers `cursor` and `hasOpenCard`.

## Adding rules / checks

A check is `(ctx) => Promise<CheckOutput | null>` registered in `checks` (see `index.server.ts`);
the performance rule (`check.type: perf-slow`, `server/checks/perf-slow`) is registered there. Fix-mode and sub agent prompts are
built from `CheckOutput`.

## RPC

`maintain.status` (rules, counters, runs today, last run, config errors), `maintain.run`
(manual run; ignores thresholds, cap and pause), `maintain.resume`.

## Known limits

- `maintenance_rule` is marked bidirectional in the sync spec but this plugin does not stamp HLCs;
  rules are effectively daemon-owned until phone-side rule editing exists.
- Fix mode: the card and session rows are written before the agent is created, so lifecycle events
  cannot arrive before the session exists.
