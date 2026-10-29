// Owner settings of vibe-board, shared by the server and the settings page.

import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const boardSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  schema: z.object({
    projectMaintenanceMigrated: z.boolean().default(false),
    projectConsolidateOnDone: z.boolean().default(true),
    projectMaintainRequirements: z.boolean().default(true),
    projectSweepOnStart: z.boolean().default(true),
    /** One plan reviewer (sub-agent of the 方案 tab) may run this long before it counts as failed. */
    planReviewTimeoutMinutes: z.number().min(1).max(240).default(20),
  }),
});
export type BoardSettingsValues = z.output<typeof boardSettings.schema>;
