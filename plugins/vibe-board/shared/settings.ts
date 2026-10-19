import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const tasksSettings = defineSettings({
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

export type TasksSettingsValues = z.output<typeof tasksSettings.schema>;
