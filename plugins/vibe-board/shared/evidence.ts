import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { EvidenceFileSchema } from "./vibe/contract";
export const verifyEvidenceRpc = defineRpc({
  name: "vibe.verify.evidence",
  input: z.object({ evidenceId: z.string(), thumb: z.boolean().optional() }),
  output: z.object({ evidence: EvidenceFileSchema, mimeType: z.string(), base64: z.string() }),
});
