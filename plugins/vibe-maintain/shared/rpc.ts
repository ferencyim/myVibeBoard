// Settings and RPC contracts of vibe-maintain.

import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { RulesConfigSchema } from "./rules";

export const maintainSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    /** How often triggers (workload, cron, watched files) are evaluated. */
    tickSeconds: z.number().int().min(5).max(3600).default(30),
    /** A rule is paused after this many consecutive rejected maintenance tasks. */
    pauseAfterRejections: z.number().int().min(1).max(20).default(3),
    /** Agent (provider/model) for sub agents and fixes when a rule does not name one. */
    defaultAgent: z.string().default("claude/sonnet"),

    // ---- advanced (WP-99); the defaults are the values that used to be hard-coded ----
    /** One sub-agent run (a rule's read-only analysis), in minutes. */
    subAgentTimeoutMinutes: z.number().min(1).max(240).default(10),
    /** Minimum seconds between `git rev-list` polls per rule (commit-count triggers). */
    commitPollSeconds: z.number().int().min(5).max(3600).default(60),
    /** Historical setting retained for stored preferences; maintenance tasks require explicit confirmation. */
    unattendedModes: z
      .record(z.string(), z.string().min(1))
      .default({ claude: "acceptEdits", codex: "auto-review" }),
  }),
});
export type MaintainSettings = z.output<typeof maintainSettings.schema>;

/**
 * Rules defined in the UI, one global table (the middle layer; see shared/rules.ts). Version 1 was
 * keyed by project; the server registers this definition with `migrate` (migrateRulesV1).
 */
export const rulesSettings = defineSettings({
  id: "rules",
  scope: "host",
  version: 2,
  schema: RulesConfigSchema,
});

const RuleView = z.object({
  rule: z.unknown(),
  counters: z.record(z.string(), z.number()),
  runsToday: z.number(),
  lastRun: z.unknown().nullable(),
  blocked: z.string().nullable(),
  projectName: z.string().nullable().default(null),
  /** builtin | custom | yml; null until the project's rules were synced once. */
  origin: z.string().nullable().default(null),
  /** Which layer supplied each field (builtin | ui | yml), by field key. */
  sources: z.record(z.string(), z.string()).nullable().default(null),
  /** The built-in default of a built-in rule (for restore-default). */
  base: z.unknown().nullable().default(null),
  prompts: z
    .object({ review: z.string().nullable(), fix: z.string().nullable() })
    .default({ review: null, fix: null }),
  triggerText: z.string().default(""),
  progressText: z.string().nullable().default(null),
  checkText: z.string().default(""),
  defined: z.boolean().default(true),
  /** Fields this project's maintenance.yml overrides (local override of the global rule). */
  ymlFields: z.array(z.string()).default([]),
});

/** A rule defined once (built-in or custom), independent of any project. */
const GlobalRuleView = z.object({
  name: z.string(),
  origin: z.string(),
  def: z.unknown(),
  sources: z.record(z.string(), z.string()),
  base: z.unknown().nullable().default(null),
  /** "all" or the project ids the rule applies to. */
  scope: z.union([z.literal("all"), z.array(z.string())]),
  splitFrom: z.string().nullable().default(null),
});

export const statusRpc = defineRpc({
  name: "maintain.status",
  input: z.object({}),
  output: z.object({
    /** One row per rule x applicable project (run state is per row). */
    rules: z.array(RuleView),
    rulesGlobal: z.array(GlobalRuleView).default([]),
    configErrors: z.record(z.string(), z.array(z.string())),
    projects: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
    presets: z.array(z.object({ id: z.string(), name: z.string(), spec: z.string() })).default([]),
  }),
});

export const runRpc = defineRpc({
  name: "maintain.run",
  /** `ruleId` runs one rule x project row; `ruleName` runs it for `projectId` or, without it, every applicable project. */
  input: z.object({
    ruleId: z.string().min(1).optional(),
    ruleName: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  }),
  output: z.object({
    status: z.string(),
    why: z.string().optional(),
    run: z.unknown().optional(),
    results: z
      .array(z.object({ projectId: z.string(), status: z.string(), why: z.string().optional() }))
      .default([]),
  }),
});

export const resumeRpc = defineRpc({
  name: "maintain.resume",
  input: z.object({ ruleId: z.string().min(1) }),
  output: z.object({ rule: z.unknown() }),
});
