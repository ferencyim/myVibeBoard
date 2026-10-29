import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const visualReplySchema = z.object({
  title: z.string().trim().min(1).max(200),
  attachmentId: z.string().uuid(),
  height: z.number().int().min(80).max(2000).optional(),
}).strict();
export const visualReplyReadRpc = defineRpc({
  name: "visual.read",
  input: z.object({ attachmentId: z.string().uuid() }).strict(),
  output: z.object({ html: z.string(), mimeType: z.literal("text/html") }).strict(),
});
export const visualReplyInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  html: z.string().min(1).max(512000),
  height: z.number().int().min(80).max(2000).optional(),
}).strict();
