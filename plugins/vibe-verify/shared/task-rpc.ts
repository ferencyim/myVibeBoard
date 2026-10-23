import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  TaskVerificationSchema,
  VerificationItemSchema,
  EvidenceFileSchema,
} from "./vibe/contract";
export const taskVerificationDetailSchema = z.object({
  verification: TaskVerificationSchema,
  items: z.array(VerificationItemSchema),
  evidence: z.array(EvidenceFileSchema),
  notes: z.array(z.string()),
});
export const taskVerifyGetRpc = defineRpc({
  name: "vibe.verify.task.get",
  input: z.object({ workspaceId: z.string().min(1), verificationId: z.string().optional() }),
  output: z.object({ detail: taskVerificationDetailSchema.nullable() }),
});
export const taskVerifyRerunRpc = defineRpc({
  name: "vibe.verify.task.rerun",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ started: z.boolean() }),
});
export const taskVerifySummarySchema = z.object({
  workspaceId: z.string(),
  text: z.string(),
  verificationId: z.string().optional(),
});
