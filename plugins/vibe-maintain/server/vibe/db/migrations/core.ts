// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { DEFAULT_TAGS } from "../../contract/enums";
import type { Migration } from "../migrate";

// Owner "core": project, card, card_event, preset, tag, card_tag, attachment, agent_session,
// plan_version, git_snapshot, vibe_event (+ cursors), sync_meta, sync_tombstone, vibe_meta.
// Run by whichever plugin starts first (vibe-board by convention); idempotent.
//
// Conventions: ids are ULID text; times are ISO-8601 UTC text; `*_json` columns hold JSON text;
// syncable rows carry `updated_hlc` (see contract/hlc.ts and contract/sync-spec.ts).

const tagSeed = DEFAULT_TAGS.map(
  (t) =>
    `INSERT OR IGNORE INTO tag (id, name, evidence, builtin, updated_hlc) VALUES ('${t.id}', '${t.name}', ${t.evidence ? 1 : 0}, 1, '');`,
).join("\n");

export const CORE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE CHECK (prefix GLOB '[A-Z]*' AND length(prefix) BETWEEN 1 AND 10),
  repo_path TEXT NOT NULL,
  project_type TEXT NOT NULL DEFAULT 'other'
    CHECK (project_type IN ('android','ios','web','desktop','backend','embedded','other')),
  default_preset_id TEXT,
  concurrency_limit INTEGER CHECK (concurrency_limit IS NULL OR concurrency_limit >= 1),
  devices_json TEXT NOT NULL DEFAULT '[]',
  paseo_project_id TEXT,
  color TEXT,
  next_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  updated_hlc TEXT NOT NULL DEFAULT ''
);

CREATE TABLE preset (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT 'accept-edits'
    CHECK (permission_mode IN ('accept-edits','auto','full')),
  environment_kind TEXT NOT NULL DEFAULT 'project-default'
    CHECK (environment_kind IN ('project-default','new-worktree')),
  base_branch TEXT,
  runtime_env TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_hlc TEXT NOT NULL DEFAULT ''
);

CREATE TABLE tag (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  evidence INTEGER NOT NULL DEFAULT 0 CHECK (evidence IN (0,1)),
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
  updated_hlc TEXT NOT NULL DEFAULT ''
);

CREATE TABLE card (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  number INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  "column" TEXT NOT NULL DEFAULT 'draft'
    CHECK ("column" IN ('draft','todo','in_progress','verifying','done')),
  sort_key TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'none'
    CHECK (priority IN ('urgent','high','medium','low','none')),
  acceptance TEXT NOT NULL DEFAULT '',
  ref_images_json TEXT NOT NULL DEFAULT '[]',
  needs_evidence INTEGER NOT NULL DEFAULT 0 CHECK (needs_evidence IN (0,1)),
  preset_id TEXT,
  suggested_preset_id TEXT,
  worktree TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','maintenance')),
  origin_ref TEXT,
  dedupe_key TEXT,
  plan_session_id TEXT,
  parent_card_id TEXT REFERENCES card(id),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_hlc TEXT NOT NULL DEFAULT '',
  UNIQUE (project_id, number)
);
CREATE INDEX idx_card_board ON card(project_id, "column", sort_key);
CREATE INDEX idx_card_parent ON card(parent_card_id);
CREATE INDEX idx_card_dedupe ON card(origin_ref, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE card_tag (
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  updated_hlc TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (card_id, tag_id)
);
CREATE INDEX idx_card_tag_tag ON card_tag(tag_id, card_id);

CREATE TABLE card_event (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('evaluation','status','switch_agent','compaction','reject','note','maintenance')),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_hlc TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_card_event_card ON card_event(card_id, created_at, id);

CREATE TABLE plan_version (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (card_id, version)
);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  card_event_id TEXT REFERENCES card_event(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_attachment_card ON attachment(card_id);

CREATE TABLE agent_session (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES card(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  workspace_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('master','planner','worker','verifier')),
  current_provider TEXT NOT NULL,
  switch_history_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'starting'
    CHECK (state IN ('starting','working','waiting','idle','ended','error')),
  waiting_since TEXT,
  pending_question_json TEXT,
  cache_expires_at TEXT,
  last_activity_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_message TEXT,
  updated_hlc TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_agent_session_card ON agent_session(card_id, state);
CREATE UNIQUE INDEX idx_agent_session_agent ON agent_session(agent_id);

CREATE TABLE git_snapshot (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  ahead INTEGER NOT NULL DEFAULT 0,
  behind INTEGER NOT NULL DEFAULT 0,
  dirty_files INTEGER NOT NULL DEFAULT 0,
  diff_stat TEXT NOT NULL DEFAULT '',
  taken_at TEXT NOT NULL
);

-- Event bus (docs/vibe/ARCHITECTURE.md 3.4). Not FK-linked: events outlive the rows they mention.
CREATE TABLE vibe_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  card_id TEXT,
  project_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT UNIQUE
);
CREATE INDEX idx_vibe_event_card ON vibe_event(card_id, seq);

-- One cursor per consumer plugin; poison events end up in vibe_event_dead.
CREATE TABLE vibe_cursor (
  consumer TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE vibe_event_dead (
  consumer TEXT NOT NULL,
  seq INTEGER NOT NULL,
  error TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, seq)
);

-- Field-level LWW metadata and tombstones for synced tables (algorithms: WP-13).
CREATE TABLE sync_meta (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  hlc TEXT NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id, column_name)
);
CREATE INDEX idx_sync_meta_hlc ON sync_meta(hlc);
CREATE TABLE sync_tombstone (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  device_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
CREATE INDEX idx_sync_tombstone_hlc ON sync_tombstone(hlc);

-- Key/value: device_id, last issued hlc.
CREATE TABLE vibe_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

${tagSeed}
`,
  },
  {
    version: 2,
    name: "sync_store",
    sql: `
-- Exchange log of the phone sync endpoint (vibe-board server/sync): current value + HLC of every
-- synced field, tombstones, both with a server arrival seq that phones use as cursor. Business
-- tables stay the source of truth; the endpoint reconciles them with this log on every exchange.
-- Epoch / seq counter / min cursor live in vibe_meta (sync_epoch, sync_seq, sync_min_cursor).
CREATE TABLE sync_field (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  column_name TEXT NOT NULL,
  value_json TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id, column_name)
);
CREATE INDEX idx_sync_field_seq ON sync_field(seq);
CREATE INDEX idx_sync_field_row ON sync_field(table_name, row_id);
CREATE TABLE sync_tomb (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
CREATE INDEX idx_sync_tomb_seq ON sync_tomb(seq);
`,
  },
  {
    version: 3,
    name: "round2",
    sql: `
-- Round 2 (reviewer model, fallback chain, stall detection, complexity, reassignment).
-- Additive and nullable: old rows keep working. agent_session.state is deliberately NOT
-- extended with 'stalled'; stalled_since marks it so existing state flows are unaffected.
ALTER TABLE card ADD COLUMN reviewer_preset_id TEXT;
ALTER TABLE preset ADD COLUMN fallback_preset_ids_json TEXT;
ALTER TABLE preset ADD COLUMN role_hint TEXT;
ALTER TABLE agent_session ADD COLUMN stalled_since TEXT;
ALTER TABLE agent_session ADD COLUMN complexity TEXT
  CHECK (complexity IS NULL OR complexity IN ('short','multi','long'));
ALTER TABLE agent_session ADD COLUMN reassigned_from_session_id TEXT;
`,
  },
  {
    version: 4,
    name: "round3_contract",
    // card_event.type / author_kind CHECK lists grow (chat, proposal, master, executor, ...);
    // SQLite cannot alter a CHECK, so the table is rebuilt (the documented 12-step procedure,
    // which needs foreign keys off: attachment.card_event_id references this table).
    foreignKeysOff: true,
    sql: `
-- Projects: several types, description, requirements file. project_type stays as the primary
-- type for old replicas (COMPAT(project-types)).
ALTER TABLE project ADD COLUMN project_types_json TEXT NOT NULL DEFAULT '[]';
UPDATE project SET project_types_json = json_array(project_type);
ALTER TABLE project ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE project ADD COLUMN requirements_path TEXT NOT NULL DEFAULT 'PRODUCT-REQUIREMENTS.md';

-- Presets: several role hints. role_hint stays as the first one (COMPAT(preset-role-hints));
-- free-text values outside the known list were never selectable and are dropped.
ALTER TABLE preset ADD COLUMN role_hints_json TEXT NOT NULL DEFAULT '[]';
UPDATE preset SET role_hint = NULL WHERE role_hint IS NOT NULL
  AND role_hint NOT IN ('worker','scout','reviewer');
UPDATE preset SET role_hints_json = json_array(role_hint) WHERE role_hint IS NOT NULL;

CREATE TABLE card_event_new (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES card(id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('evaluation','status','switch_agent','compaction','reject','note','maintenance','chat','proposal')),
  author_kind TEXT NOT NULL
    CHECK (author_kind IN ('user','agent','master','executor','reviewer','scout','system')),
  author TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_hlc TEXT NOT NULL DEFAULT ''
);
INSERT INTO card_event_new (id, card_id, type, author_kind, author, body_json, created_at, updated_hlc)
  SELECT id, card_id, type, author_kind, author, body_json, created_at, updated_hlc FROM card_event;
DROP TABLE card_event;
ALTER TABLE card_event_new RENAME TO card_event;
CREATE INDEX idx_card_event_card ON card_event(card_id, created_at, id);
`,
  },
  {
    version: 5,
    name: "prompt_registry",
    sql: `
-- Prompt registry (WP-98). prompt_template: defaults and metadata, written only by the plugin
-- that owns the prompt (register on start-up). prompt_override: the owner's text, global
-- (project_id NULL) or per project; text '' = no override. id = '<key>@<project id or *>' (stable
-- across devices so the phone can create/edit overrides offline).
CREATE TABLE prompt_template (
  key TEXT PRIMARY KEY,
  plugin TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  when_sent TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  default_text TEXT NOT NULL,
  placeholders_json TEXT NOT NULL DEFAULT '[]',
  fixed_suffix TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE prompt_override (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  project_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_hlc TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_prompt_override_scope ON prompt_override(key, COALESCE(project_id, ''));
`,
  },
];
