import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { COMPACT_PROVIDERS, DEFAULT_MARGIN_RULE, FALLBACK_TTL_SECONDS } from "./policy";

export const compactionSettings = defineSettings({
  id: "compaction",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    /** Prompt-cache TTL per provider id (claude: 3600 subscription / 300 API key). */
    ttlSeconds: z.record(z.string(), z.number().int().positive()).default({}),
    /** Overrides the derived pre-expiry margin. */
    marginSeconds: z.number().positive().optional(),
    /** How often idle sessions are checked. */
    checkIntervalSeconds: z.number().positive().default(20),

    // ---- advanced (WP-99); the defaults are the values that used to be hard-coded ----
    /** TTL of a provider that has neither a setting nor a built-in default. */
    fallbackTtlSeconds: z.number().int().positive().default(FALLBACK_TTL_SECONDS),
    /** Margin rule: a TTL of at least marginLongFromSeconds opens the window marginLongSeconds before expiry, else marginShortSeconds. */
    marginLongFromSeconds: z.number().positive().default(DEFAULT_MARGIN_RULE.longFrom),
    marginLongSeconds: z.number().positive().default(DEFAULT_MARGIN_RULE.long),
    marginShortSeconds: z.number().positive().default(DEFAULT_MARGIN_RULE.short),
    /** Providers whose CLI understands the compact command; the others are handed over instead. */
    compactProviders: z.array(z.string().min(1)).default([...COMPACT_PROVIDERS]),
    /** Compact command per provider; a provider not listed gets "/compact". */
    compactCommands: z.record(z.string(), z.string().min(1)).default({}),
    /** How long a compaction turn may wait for the user to answer an approval. */
    approvalWaitMinutes: z.number().positive().max(240).default(10),
  }),
});

export type CompactionSettingsValues = z.output<typeof compactionSettings.schema>;
