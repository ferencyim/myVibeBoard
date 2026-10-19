import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const boardSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    autoInjectCliAndMcp: z.boolean().default(true),
    autoInjectInstructions: z.boolean().default(true),
    defaultView: z.enum(["list", "board"]).default("board"),
    showCompletedInBoard: z.boolean().default(true),
  }),
});

/** Legacy name still imported by the pre-WP-11 client; WP-11 removes it. */
export const tasksSettings = boardSettings;

export type BoardSettingsValues = z.output<typeof boardSettings.schema>;
