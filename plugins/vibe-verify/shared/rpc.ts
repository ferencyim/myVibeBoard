// vibe-verify plugin RPC contract (WP-20). Runtime-neutral: used by the server handlers and by the
// "verification result" UI of vibe-board (WP-21), which copies this file next to its own contract.
// Errors are thrown as `Error("[<code>] <message>")`, code one of
// not_found | invalid | conflict | unavailable.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  EvidenceFileSchema,
  JudgementSchema,
  VerificationItemSchema,
  VerificationSchema,
} from "./vibe/contract";

const cardRef = z.string().min(1);

export const verificationDetailSchema = z.object({
  verification: VerificationSchema,
  /** One-line headline: "All checks passed" / "Some checks are doubtful" / "Some checks failed". */
  summary: z.string(),
  items: z.array(VerificationItemSchema),
  /** Evidence files; paths are absolute on the daemon host. Fetch bytes with vibe.verify.evidence. */
  evidence: z.array(EvidenceFileSchema),
  /** Notes that apply to the whole run (degraded collectors, voided evidence, ...). */
  notes: z.array(z.string()),
});
export type VerificationDetail = z.infer<typeof verificationDetailSchema>;

/** Latest verification of a card (or a specific one) with items and evidence; null if none. */
export const verifyGetRpc = defineRpc({
  name: "vibe.verify.get",
  input: z.object({ card: cardRef, verificationId: z.string().optional() }),
  output: z.object({ detail: verificationDetailSchema.nullable() }),
});

export const verifyListRpc = defineRpc({
  name: "vibe.verify.list",
  input: z.object({ card: cardRef }),
  output: z.object({ verifications: z.array(VerificationSchema) }),
});

/** Evidence bytes; with `thumb` the thumbnail when one exists (base64, lazy-loaded by the UI). */
export const verifyEvidenceRpc = defineRpc({
  name: "vibe.verify.evidence",
  input: z.object({ evidenceId: z.string(), thumb: z.boolean().optional() }),
  output: z.object({ evidence: EvidenceFileSchema, mimeType: z.string(), base64: z.string() }),
});

/** User presses "pass": verifying -> done (actor user). */
export const verifyApproveRpc = defineRpc({
  name: "vibe.verify.approve",
  input: z.object({ card: cardRef }),
  output: z.object({ ok: z.literal(true) }),
});

/** User rejects with one sentence: verifying -> in_progress, the sentence goes to the worker. */
export const verifyRejectRpc = defineRpc({
  name: "vibe.verify.reject",
  input: z.object({ card: cardRef, comment: z.string().trim().min(1) }),
  output: z.object({ ok: z.literal(true), notifiedWorker: z.boolean() }),
});

/** Start a new verification of a card currently in `verifying` (e.g. after a doubtful result). */
export const verifyRerunRpc = defineRpc({
  name: "vibe.verify.rerun",
  input: z.object({ card: cardRef }),
  output: z.object({ started: z.boolean() }),
});

export const verifyConclusionSchema = JudgementSchema;
