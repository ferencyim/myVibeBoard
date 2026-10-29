// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { z } from "zod";

export const BotThreadSchema = z.object({
  id: z.string(), botId: z.string(), title: z.string(), agentId: z.string().nullable(),
  createdAt: z.string(), archivedAt: z.string().nullable(),
});
export type BotThread = z.infer<typeof BotThreadSchema>;
