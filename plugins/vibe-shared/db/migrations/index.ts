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
export const OWNERS = ["core", "verify", "context", "scheduler", "stats", "maintain", "vibe-bots"] as const;
export type Owner = (typeof OWNERS)[number];

export const MIGRATIONS: Readonly<Record<Owner, readonly Migration[]>> = {
  core: CORE_MIGRATIONS,
  "vibe-bots": BOT_MIGRATIONS,
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
  verify: ["core"],
  context: ["core"],
  scheduler: ["core"],
  stats: ["core"],
  maintain: ["core"],
};
