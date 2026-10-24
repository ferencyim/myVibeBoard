import type { Migration } from "../migrate";

// DDL for the non-core owners. Each depends on "core" (see OWNER_DEPENDS in migrations/index.ts).

export const VERIFY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('pass','doubt','fail')),
  verifier_agent_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('evidence','tests_only')),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_verification_card ON verification(card_id, started_at);

CREATE TABLE verification_item (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES verification(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  check_text TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  judgement TEXT CHECK (judgement IS NULL OR judgement IN ('pass','doubt','fail')),
  note TEXT NOT NULL DEFAULT '',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_verification_item_v ON verification_item(verification_id, position);

CREATE TABLE evidence_file (
  id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES verification(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES verification_item(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot','gif','video','log','report','photo')),
  path TEXT NOT NULL,
  thumb_path TEXT,
  sha256 TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0,1))
);
CREATE INDEX idx_evidence_file_v ON evidence_file(verification_id);
`,
  },
  {
    version: 2,
    name: "review_kind",
    sql: `
-- Round 2: a verification (and its items) is either an acceptance check or a model review.
ALTER TABLE verification ADD COLUMN kind TEXT NOT NULL DEFAULT 'check' CHECK (kind IN ('check','review'));
ALTER TABLE verification_item ADD COLUMN kind TEXT NOT NULL DEFAULT 'check' CHECK (kind IN ('check','review'));
`,
  },
  {
    version: 3,
    name: "workspace_task_evidence",
    foreignKeysOff: true,
    sql: `
CREATE TABLE verification_new (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES card(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('pass','doubt','fail')),
  verifier_agent_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('evidence','tests_only')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  kind TEXT NOT NULL DEFAULT 'check' CHECK (kind IN ('check','review')),
  workspace_id TEXT REFERENCES task(workspace_id),
  confirmed_at TEXT,
  project_id TEXT
);
INSERT INTO verification_new (id,card_id,commit_hash,conclusion,verifier_agent_id,mode,started_at,finished_at,kind)
SELECT id,card_id,commit_hash,conclusion,verifier_agent_id,mode,started_at,finished_at,kind FROM verification;
UPDATE verification_new SET project_id = (SELECT project_id FROM card WHERE card.id = verification_new.card_id);
DROP TABLE verification;
ALTER TABLE verification_new RENAME TO verification;
CREATE INDEX idx_verification_card ON verification(card_id,started_at);
CREATE INDEX idx_verification_workspace ON verification(workspace_id,confirmed_at,started_at);
`,
  },
];

// The cutover invokes this owner migration inside the same transaction as core v14.
VERIFY_MIGRATIONS.push({
  version: 4,
  name: "retire_card_evidence",
  foreignKeysOff: true,
  sql: `
DELETE FROM evidence_file WHERE verification_id IN (SELECT id FROM verification WHERE card_id IS NOT NULL);
DELETE FROM verification_item WHERE verification_id IN (SELECT id FROM verification WHERE card_id IS NOT NULL);
CREATE TABLE verification_new (
  id TEXT PRIMARY KEY,
  card_id TEXT CHECK (card_id IS NULL),
  commit_hash TEXT NOT NULL,
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('pass','doubt','fail')),
  verifier_agent_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('evidence','tests_only')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  kind TEXT NOT NULL DEFAULT 'check' CHECK (kind IN ('check','review')),
  workspace_id TEXT REFERENCES task(workspace_id),
  confirmed_at TEXT,
  project_id TEXT
);
INSERT INTO verification_new SELECT * FROM verification WHERE card_id IS NULL;
DROP TABLE verification;
ALTER TABLE verification_new RENAME TO verification;
CREATE INDEX idx_verification_workspace ON verification(workspace_id,confirmed_at,started_at);
`,
});

export const CONTEXT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
-- Index of memory entries; the Markdown files themselves live in <repo>/.vibe/.
CREATE TABLE memory_entry (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  touched_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
CREATE INDEX idx_memory_entry_file ON memory_entry(project_id, file, archived, touched_at);
`,
  },
];

export const SCHEDULER_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE resource_sample (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  cpu REAL NOT NULL,
  mem REAL NOT NULL,
  per_session_json TEXT NOT NULL DEFAULT '{}',
  device_pool_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_resource_sample_ts ON resource_sample(ts);

CREATE TABLE device (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('emulator','simulator','board','debugger','camera','other')),
  name TEXT NOT NULL UNIQUE,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Exclusive leases: at most one active (unreleased) lease per device.
CREATE TABLE device_lease (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  card_id TEXT,
  session_id TEXT,
  acquired_at TEXT NOT NULL,
  expires_at TEXT,
  released_at TEXT
);
CREATE UNIQUE INDEX idx_device_lease_active ON device_lease(device_id) WHERE released_at IS NULL;
`,
  },
  {
    version: 2,
    name: "workspace_task_leases",
    sql: `ALTER TABLE device_lease ADD COLUMN workspace_id TEXT;`,
  },
];

export const STATS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE usage_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  cost REAL,
  card_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_usage_event_ts ON usage_event(ts);
CREATE INDEX idx_usage_event_provider ON usage_event(provider, model, ts);
CREATE INDEX idx_usage_event_card ON usage_event(card_id);

-- Incremental read position per log file.
CREATE TABLE usage_cursor (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "workspace_usage_attribution",
    sql: `
ALTER TABLE usage_event ADD COLUMN project_id TEXT;
ALTER TABLE usage_event ADD COLUMN workspace_id TEXT;
ALTER TABLE usage_event ADD COLUMN role TEXT;
ALTER TABLE usage_event ADD COLUMN agent_id TEXT;
UPDATE usage_event SET project_id = (SELECT project_id FROM card WHERE card.id = usage_event.card_id);
CREATE INDEX idx_usage_event_workspace ON usage_event(workspace_id,ts);
CREATE INDEX idx_usage_event_project ON usage_event(project_id,ts);
`,
  },
];

export const MAINTAIN_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE maintenance_rule (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('workload','time','event')),
  trigger_json TEXT NOT NULL DEFAULT '{}',
  check_json TEXT NOT NULL DEFAULT '{}',
  agent TEXT,
  output_mode TEXT NOT NULL DEFAULT 'suggest' CHECK (output_mode IN ('suggest','fix')),
  priority TEXT NOT NULL DEFAULT 'low',
  dedupe_key TEXT,
  daily_cap INTEGER NOT NULL DEFAULT 1 CHECK (daily_cap >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  paused_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_hlc TEXT NOT NULL DEFAULT '',
  UNIQUE (project_id, name)
);

CREATE TABLE maintenance_run (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES maintenance_rule(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','skipped','failed')),
  dedupe_key TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  card_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_maintenance_run_rule ON maintenance_run(rule_id, triggered_at);

-- Workload counters since the last trigger (cards done, merged commits, tokens).
CREATE TABLE work_counter (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  since TEXT NOT NULL,
  PRIMARY KEY (project_id, kind)
);
`,
  },
  {
    version: 2,
    name: "workspace_maintenance_tasks",
    sql: `
ALTER TABLE maintenance_run ADD COLUMN workspace_ids_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE maintenance_task (
  workspace_id TEXT PRIMARY KEY REFERENCES task(workspace_id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES maintenance_rule(id),
  project_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  rejected_at TEXT
);
CREATE INDEX idx_maintenance_task_dedupe ON maintenance_task(rule_id,project_id,dedupe_key);
`,
  },
];
