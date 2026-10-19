import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const boardSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoInjectCliAndMcp: z.boolean().default(true),
    autoInjectInstructions: z.boolean().default(true),
  }),
});

export type BoardSettingsValues = z.output<typeof boardSettings.schema>;
