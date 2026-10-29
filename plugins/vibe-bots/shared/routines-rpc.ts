import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RoutineCreateSchema, RoutinePatchSchema, RoutineSchema } from "./vibe/contract/routines";
export const routinesListRpc = defineRpc({ name: "routines.list", input: z.object({ botId: z.string().optional() }), output: z.object({ routines: z.array(RoutineSchema) }) });
export const routinesCreateRpc = defineRpc({ name: "routines.create", input: RoutineCreateSchema, output: z.object({ routine: RoutineSchema }) });
export const routinesUpdateRpc = defineRpc({ name: "routines.update", input: z.object({ id: z.string(), patch: RoutinePatchSchema }), output: z.object({ routine: RoutineSchema }) });
const id = z.object({ id: z.string() });
export const routinesPauseRpc = defineRpc({ name: "routines.pause", input: id, output: z.object({ routine: RoutineSchema }) });
export const routinesResumeRpc = defineRpc({ name: "routines.resume", input: id, output: z.object({ routine: RoutineSchema }) });
export const routinesDeleteRpc = defineRpc({ name: "routines.delete", input: id, output: z.object({ ok: z.literal(true) }) });
export const routinesRunNowRpc = defineRpc({ name: "routines.run_now", input: id, output: z.object({ ok: z.literal(true) }) });

export const routineTickRpc = defineRpc({ name: "routine.tick", input: z.object({ paused: z.boolean(), running: z.object({ total: z.number(), byProvider: z.record(z.string(), z.number()), byProject: z.record(z.string(), z.number()) }), globalLimit: z.number(), providerLimits: z.record(z.string(), z.number()), projectLimits: z.record(z.string(), z.number()), quota: z.record(z.string(), z.object({ level: z.string() }).passthrough()) }), output: z.object({ started: z.boolean() }) });
