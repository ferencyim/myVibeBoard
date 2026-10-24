// 原生任务证据读取合同。
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { EvidenceFileSchema } from "./vibe/contract";

/** Evidence bytes; with thumb, return the thumbnail when available. */
export const verifyEvidenceRpc = defineRpc({
  name: "vibe.verify.evidence",
  input: z.object({ evidenceId: z.string(), thumb: z.boolean().optional() }),
  output: z.object({ evidence: EvidenceFileSchema, mimeType: z.string(), base64: z.string() }),
});
