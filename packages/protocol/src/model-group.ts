import { z } from "zod";

export const ModelGroupEntrySchema = z.object({
  order: z.number(),
  provider: z.string(),
  model: z.string(),
  thinkingOptionId: z.string().optional(),
});

export const ModelGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  entries: z.array(ModelGroupEntrySchema),
});

export type ModelGroupEntry = z.infer<typeof ModelGroupEntrySchema>;
export type ModelGroup = z.infer<typeof ModelGroupSchema>;
