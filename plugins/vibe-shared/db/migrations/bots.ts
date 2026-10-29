import type { Migration } from "../migrate";

export const BOT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "bot_identity_and_memory",
    sql: `
CREATE TABLE bot (
  id TEXT PRIMARY KEY CHECK(id GLOB 'bot_*'),
  kind TEXT NOT NULL CHECK(kind IN ('independent','project')),
  project_id TEXT,
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  avatar_seed TEXT NOT NULL DEFAULT '',
  avatar_hue INTEGER NOT NULL DEFAULT 210,
  avatar_path TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  preset_id TEXT,
  provider TEXT,
  model TEXT,
  thinking TEXT NOT NULL DEFAULT '',
  backup_models_json TEXT NOT NULL DEFAULT '[]',
  notifications_json TEXT NOT NULL DEFAULT '{}',
  permission_mode TEXT NOT NULL DEFAULT 'accept-edits',
  main_agent_id TEXT,
  pending_model INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK((kind='project' AND project_id IS NOT NULL) OR (kind='independent' AND project_id IS NULL))
);
CREATE INDEX idx_bot_project ON bot(kind,project_id,archived_at);
CREATE UNIQUE INDEX idx_bot_main_agent ON bot(main_agent_id) WHERE main_agent_id IS NOT NULL;
CREATE TABLE bot_memory (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bot(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  source TEXT NOT NULL CHECK(source IN ('bot','user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_bot_memory ON bot_memory(bot_id,pinned DESC,updated_at DESC);
CREATE TABLE bot_memory_delivery (
  agent_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bot(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL,
  instructions TEXT NOT NULL
);
CREATE TABLE project_default_bot (
  project_id TEXT PRIMARY KEY,
  default_bot_id TEXT NOT NULL REFERENCES bot(id)
);
CREATE TABLE bot_legacy_migration (
  source TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bot(id)
);
CREATE TABLE bot_model_state (
  bot_id TEXT PRIMARY KEY REFERENCES bot(id),
  candidate_index INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE bot_continuation_request (
  request_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  result_json TEXT
);
`,
  },
];
