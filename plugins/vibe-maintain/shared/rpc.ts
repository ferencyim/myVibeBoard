// Settings and RPC contracts of vibe-maintain.

import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const maintainSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    /** How often triggers (workload, cron, watched files) are evaluated. */
    tickSeconds: z.number().int().min(5).max(3600).default(30),
    /** A rule is paused after this many consecutive rejected maintenance cards. */
    pauseAfterRejections: z.number().int().min(1).max(20).default(3),
    /** Agent (provider/model) for sub agents and fixes when a rule does not name one. */
    defaultAgent: z.string().default("claude/sonnet"),
  }),
});
export type MaintainSettings = z.output<typeof maintainSettings.schema>;

const RuleView = z.object({
  rule: z.unknown(),
  counters: z.record(z.string(), z.number()),
  runsToday: z.number(),
  lastRun: z.unknown().nullable(),
  blocked: z.string().nullable(),
  projectName: z.string().nullable().default(null),
});

export const statusRpc = defineRpc({
  name: "maintain.status",
  input: z.object({}),
  output: z.object({
    rules: z.array(RuleView),
    configErrors: z.record(z.string(), z.array(z.string())),
  }),
});

export const runRpc = defineRpc({
  name: "maintain.run",
  input: z.object({ ruleId: z.string().min(1) }),
  output: z.object({ status: z.string(), why: z.string().optional(), run: z.unknown().optional() }),
});

export const resumeRpc = defineRpc({
  name: "maintain.resume",
  input: z.object({ ruleId: z.string().min(1) }),
  output: z.object({ rule: z.unknown() }),
});
