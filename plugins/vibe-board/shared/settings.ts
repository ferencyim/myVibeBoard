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
  }),
});

export type BoardSettingsValues = z.output<typeof boardSettings.schema>;
