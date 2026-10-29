// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { z } from "zod";

export const RoutineScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), expression: z.string().trim().min(1) }),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(1) }),
]);
export const RoutineFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200), schedule: RoutineScheduleSchema,
  timezone: z.string().min(1), prompt: z.string().trim().min(1).max(30000),
  target: z.enum(["main", "new_thread"]).default("main"), quiet: z.boolean().default(false),
  missedPolicy: z.enum(["skip", "run_once"]).default("skip"),
});
export const RoutineCreateSchema = RoutineFieldsSchema.extend({ botId: z.string().min(1) });
export const RoutinePatchSchema = RoutineFieldsSchema.partial().strict();
export const RoutineSchema = RoutineFieldsSchema.extend({
  id: z.string(), botId: z.string(), paused: z.boolean(), lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(), lastStatus: z.string().nullable(), lastError: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;
export type RoutineCreate = z.input<typeof RoutineCreateSchema>;
export type RoutinePatch = z.input<typeof RoutinePatchSchema>;
export type RoutineSchedule = z.infer<typeof RoutineScheduleSchema>;
