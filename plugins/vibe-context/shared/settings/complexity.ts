import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_THRESHOLDS } from "./defaults";

export const complexitySettings = defineSettings({
  id: "complexity",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Master switch: classify sessions and apply the per-complexity policy. */
    enabled: z.boolean().default(true),
    shortMaxTurns: z.number().int().positive().default(DEFAULT_THRESHOLDS.shortMaxTurns),
    longMinTurns: z.number().int().positive().default(DEFAULT_THRESHOLDS.longMinTurns),
    longCacheRead: z.number().positive().default(DEFAULT_THRESHOLDS.longCacheRead),
    heavyTurnContext: z.number().positive().default(DEFAULT_THRESHOLDS.heavyTurnContext),
    heavyTurnShare: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.heavyTurnShare),
    /** Long sessions are compacted at the next idle moment even if the cache is still hot. */
    earlyCompactLong: z.boolean().default(true),
    /** A long session that is long again after this many early compactions is handed over. */
    handoffAfterCompactions: z.number().int().positive().default(2),
    /** Memory tokens inlined at (re-)injection for multi/long sessions; the rest become pointers. */
    tightMemoryTokens: z.number().int().nonnegative().default(1000),
  }),
});

export type ComplexitySettingsValues = z.output<typeof complexitySettings.schema>;
