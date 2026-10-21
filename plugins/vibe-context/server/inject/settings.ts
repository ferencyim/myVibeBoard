import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Memory tokens inlined into the injected block unless a tighter budget applies. */
export const DEFAULT_MEMORY_TOKENS = 6000;

export const contextSettings = defineSettings({
  id: "context",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Memory tokens inlined into the injected context block (the rest become pointers). */
    defaultMemoryTokens: z.number().int().min(0).max(200_000).default(DEFAULT_MEMORY_TOKENS),
  }),
});

export type ContextSettingsValues = z.output<typeof contextSettings.schema>;
