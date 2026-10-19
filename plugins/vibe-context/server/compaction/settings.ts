import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
  }),
});

export type CompactionSettingsValues = z.output<typeof compactionSettings.schema>;
