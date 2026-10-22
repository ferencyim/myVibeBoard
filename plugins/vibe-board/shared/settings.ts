import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Keys WP-105 removed: execution-phase scouting (scouts only run when planning now) and the hand-off clip. */
export const REMOVED_BOARD_SETTING_KEYS = [
  "scoutPreset",
  "scoutMaxParallel",
  "scoutTimeoutSec",
  "scoutCacheTtlMinutes",
  "scoutSummaryMaxLines",
  "scoutMaxTasksPerCall",
  "briefHandoffMaxChars",
] as const;

export const boardSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  /** v1 -> v2 (WP-105): drop the execution-phase scout settings. */
  migrate: (values) => {
    if (!values || typeof values !== "object") return values;
    const next: Record<string, unknown> = { ...(values as Record<string, unknown>) };
    for (const key of REMOVED_BOARD_SETTING_KEYS) delete next[key];
    return next;
  },
  schema: z.object({
    autoInjectCliAndMcp: z.boolean().default(true),
    autoInjectInstructions: z.boolean().default(true),
    /** What happens when a card reaches done: merge its worktree branch, open a PR, or nothing. */
    finalizeMode: z.enum(["merge", "pr", "none"]).default("merge"),
    /** Branch to merge into; empty = whatever the project's main checkout is on. */
    finalizeTargetBranch: z.string().default(""),
    /** Stall watchdog: mark a working session with no output for this long (card shows "may be stuck"). */
    stallDetection: z.boolean().default(true),
    stallMinutes: z.number().min(1).default(10),
    /** Per-provider override of stallMinutes, e.g. "claude=15,codex=8". */
    stallProviderMinutes: z.string().default(""),
    /** After this many more minutes stalled, interrupt the agent and send one "continue" prompt (0 = off). */
    stallAutoInterruptMinutes: z.number().min(0).default(0),
    /** A worker failing on quota / login / provider errors moves to the preset's fallback chain. */
    failoverEnabled: z.boolean().default(true),
    /** Advanced limits (WP-98). Brief: newest notes / execution chat messages listed. */
    briefRecentEvents: z.number().int().min(1).max(50).default(5),
    briefChatLimit: z.number().int().min(0).max(50).default(8),
    /** How often the stall watchdog looks at working sessions (read at start-up). */
    watchdogPollSeconds: z.number().int().min(5).max(600).default(30),
  }),
});

export type BoardSettingsValues = z.output<typeof boardSettings.schema>;
