// Verification-result RPCs served by vibe-board (WP-21) for its card UI. A plugin client can only
// call its own plugin's RPCs, so vibe-board reads vibe-verify's tables in the shared vibe.db and
// turns reject/rerun into `verification.decision_requested` events that vibe-verify consumes.
// Derived from plugins/vibe-verify/shared/rpc.ts (same names and shapes, except `reject`/`rerun`
// are queued: the worker notification happens asynchronously in vibe-verify).
// Errors are thrown as `Error("[<code>] <message>")`, code one of
// not_found | invalid | conflict | unavailable | too_large.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  EvidenceFileSchema,
  VerificationItemSchema,
  VerificationSchema,
} from "../vibe/contract";

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

/** Evidence bytes; with `thumb` the thumbnail (PNG, width <= 320) when one exists, else the original. */
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

/** User rejects with one sentence (queued): vibe-verify moves the card back and sends it to the worker. */
export const verifyRejectRpc = defineRpc({
  name: "vibe.verify.reject",
  input: z.object({ card: cardRef, comment: z.string().trim().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});

/** Queue a new verification of a card currently in `verifying` (e.g. after a doubtful result). */
export const verifyRerunRpc = defineRpc({
  name: "vibe.verify.rerun",
  input: z.object({ card: cardRef }),
  output: z.object({ queued: z.literal(true) }),
});


export const VIBE_VERIFY_UI_RPCS = {
  verifyGetRpc,
  verifyListRpc,
  verifyEvidenceRpc,
  verifyApproveRpc,
  verifyRejectRpc,
  verifyRerunRpc,
} as const;
