# vibe-stats

myVibeBoard overview page and usage indexer (WP-45). Supported Paseo versions: see
`requirements.paseo` in `paseo-plugin.json`.

## What it does

- **Indexer** (`server/indexer.ts`): scans the CLI log directories every `scanIntervalSeconds`
  (and after each agent turn), reads each file from its saved byte offset (`usage_cursor`), and
  upserts `usage_event` rows. `dedupe_key` makes re-reads harmless; a shrunk file restarts at 0.
- **Card link**: Paseo agent `persistence.sessionId` -> `agent_session.agent_id` -> `card_id`;
  events of known sessions get `card_id` on the next scan.
- **Overview screen** (React Native, desktop and Android): token distribution by agent / model /
  project / day, estimated cost, output speed (median and P90 tokens/s), quota windows
  (`providers.listUsage()`), per-task efficiency (tokens, active time, time waiting for you,
  compactions), resources (sessions plus the scheduler's `resource_sample`, read-only).

## Log locations

| CLI         | Default                                          | Status                                  |
| ----------- | ------------------------------------------------ | --------------------------------------- |
| Claude Code | `~/.config/claude/projects`, `~/.claude/projects` (`CLAUDE_CONFIG_DIR`) | verified |
| Codex       | `~/.codex/sessions/**/rollout-*.jsonl` (`CODEX_HOME`) | verified                           |
| Kimi        | `~/.kimi/sessions/**/wire.jsonl`                 | **unverified** (not installed here)     |
| DeepSeek    | `~/.dsh/sessions/**/*.jsonl` (`DSH_HOME`)        | **unverified**; tolerant `usage` parser |

All four are overridable in the plugin settings (Stats > settings). Parsers for Kimi and DeepSeek
are best effort until a real install is available; fix `server/parsers.ts` then.

## Definitions

- Tokens: `input` is uncached input, `cacheRead` / `cacheWrite` as logged. Codex `input_tokens`
  includes cached tokens, so cached tokens are subtracted from input and shown as cache read.
- Claude totals follow ccusage: one entry per `message.id:requestId` (first wins), synthetic
  messages skipped. Test: `test/indexer.test.ts` "reconciliation with ccusage" (fixture, independent
  restatement of the algorithm). Real-log check against the actual tool: see below.
- Output speed: `output tokens / turn duration`; duration is the gap since the previous log line
  (Claude: from the line before the message's first block to its last block), idle gaps over 30
  minutes are ignored. Events without a measurable duration are excluded.
- Cost: log-reported `costUSD` if present, else tokens x built-in estimate table
  (`server/pricing.ts`). Set `pricingFile` to a LiteLLM-format price JSON (ccusage's dataset) to
  override. Unknown models have no cost, and the Claude 5 family (`fable`, `opus/sonnet/haiku-5`) and
  `gpt-6` models are deliberately left unpriced until a price file names them (no invented prices): the
  overview shows their tokens as "unpriced" (`unpricedTokens`) with a hint to set `pricingFile`. A cost is
  fixed when a row is first indexed; a full reindex keeps existing rows (their logs may already be deleted
  by the CLI) and only fills gaps, including the cost of previously unpriced rows.
- Compaction: no table of its own; a call whose context (input + cache) drops below half of the
  previous call's (and the previous was at least 20k) in the same CLI session counts as one.
- Waiting for you: sum of `session.waiting` -> `session.answered` intervals in `vibe_event`.
- Resources: `resource_sample.cpu` / `mem` are read as fractions (0..1); `device_pool_json` as
  `{busy,total}` or a device map with `leased` flags. Adjust `readPool` if WP-34 differs.

## Reconcile with the real ccusage

    VIBE_E2E_CCUSAGE=1 npm test -- reconcile      # VIBE_CCUSAGE_CMD overrides "npx ccusage"

Indexes this machine's real Claude logs in memory and compares daily totals with
`ccusage daily --json --offline`. Skipped by default (reads real logs; `npx` downloads ccusage).

## Commands

    npm ci && npm run typecheck && npm test
