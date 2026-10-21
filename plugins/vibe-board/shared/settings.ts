import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const boardSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoInjectCliAndMcp: z.boolean().default(true),
    autoInjectInstructions: z.boolean().default(true),
    /** What happens when a card reaches done: merge its worktree branch, open a PR, or nothing. */
    finalizeMode: z.enum(["merge", "pr", "none"]).default("merge"),
    /** Branch to merge into; empty = whatever the project's main checkout is on. */
    finalizeTargetBranch: z.string().default(""),
    /** Preset (name or id) used for vibe_scout sub-agents; empty = role_hint=scout, else the cheapest. */
    scoutPreset: z.string().default(""),
    /** Concurrent scouts (1-16). */
    scoutMaxParallel: z.number().int().min(1).max(16).default(4),
    /** Per-scout timeout in seconds; on timeout only the findings so far are returned. */
    scoutTimeoutSec: z.number().int().min(10).max(3600).default(300),
    /** Stall watchdog: mark a working session with no output for this long (card shows "may be stuck"). */
    stallDetection: z.boolean().default(true),
    stallMinutes: z.number().min(1).default(10),
    /** Per-provider override of stallMinutes, e.g. "claude=15,codex=8". */
    stallProviderMinutes: z.string().default(""),
    /** After this many more minutes stalled, interrupt the agent and send one "continue" prompt (0 = off). */
    stallAutoInterruptMinutes: z.number().min(0).default(0),
    /** A worker failing on quota / login / provider errors moves to the preset's fallback chain. */
    failoverEnabled: z.boolean().default(true),
    /** Advanced limits (WP-98). Brief: newest notes / chat messages listed, hand-off summary clip. */
    briefRecentEvents: z.number().int().min(1).max(50).default(5),
    briefChatLimit: z.number().int().min(0).max(50).default(8),
    briefHandoffMaxChars: z.number().int().min(500).max(100000).default(8000),
    /** Scout answer cache in minutes (0 = no cache), answer length and tasks per vibe_scout call. */
    scoutCacheTtlMinutes: z.number().min(0).max(240).default(10),
    scoutSummaryMaxLines: z.number().int().min(3).max(200).default(20),
    scoutMaxTasksPerCall: z.number().int().min(1).max(64).default(16),
    /** How often the stall watchdog looks at working sessions (read at start-up). */
    watchdogPollSeconds: z.number().int().min(5).max(600).default(30),
  }),
});

export type BoardSettingsValues = z.output<typeof boardSettings.schema>;
