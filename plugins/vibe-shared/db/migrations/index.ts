import type { Migration } from "../migrate";
import { CORE_MIGRATIONS } from "./core";
import { BOT_MIGRATIONS } from "./bots";
import {
  CONTEXT_MIGRATIONS,
  MAINTAIN_MIGRATIONS,
  SCHEDULER_MIGRATIONS,
  STATS_MIGRATIONS,
  VERIFY_MIGRATIONS,
} from "./owners";

/** Table owners. Only the owner runs DDL for its tables (docs/vibe/ARCHITECTURE.md 3.3). */
export const OWNERS = ["core", "verify", "context", "scheduler", "stats", "maintain", "vibe-bots", "vibe-board"] as const;
export type Owner = (typeof OWNERS)[number];

export const MIGRATIONS: Readonly<Record<Owner, readonly Migration[]>> = {
  core: CORE_MIGRATIONS,
  "vibe-bots": BOT_MIGRATIONS,
  "vibe-board": [{ version: 1, name: "task_flow_level", sql: `
ALTER TABLE task ADD COLUMN flow_level TEXT NOT NULL DEFAULT 'full' CHECK (flow_level IN ('simple','medium','full'));
ALTER TABLE task ADD COLUMN flow_source TEXT NOT NULL DEFAULT 'user' CHECK (flow_source IN ('user','bot'));
ALTER TABLE task ADD COLUMN flow_reason TEXT NOT NULL DEFAULT '';
` }],
  verify: VERIFY_MIGRATIONS,
  context: CONTEXT_MIGRATIONS,
  scheduler: SCHEDULER_MIGRATIONS,
  stats: STATS_MIGRATIONS,
  maintain: MAINTAIN_MIGRATIONS,
};

/** Owners whose tables reference another owner's tables migrate that owner first. */
export const OWNER_DEPENDS: Readonly<Record<Owner, readonly Owner[]>> = {
  core: [],
  "vibe-bots": ["core"],
  "vibe-board": ["core"],
  verify: ["core"],
  context: ["core"],
  scheduler: ["core"],
  stats: ["core"],
  maintain: ["core"],
};
