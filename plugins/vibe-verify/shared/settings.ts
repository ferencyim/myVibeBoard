// Settings of vibe-verify (WP-99), shared by the server and the settings page. Every default equals
// the value that used to be hard-coded.

import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SEVERITY_JUDGEMENTS = ["pass", "doubt", "fail"] as const;
const judgement = z.enum(SEVERITY_JUDGEMENTS);

export const verifySettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Failed verification (or severe review) sends the card back to the worker; false = leave it in verifying. */
    autoReturnOnFail: z.boolean().default(true),
    /**
     * Consecutive review-triggered returns after which a severe review is only "doubt".
     * null = not set here: env VIBE_REVIEW_MAX_RETURNS, else 3.
     */
    // COMPAT(env-review-max-returns): added 2026-10-21, remove after 2027-04-01
    maxReviewReturns: z.number().int().min(0).max(20).nullable().default(null),
    /** Review issue severity -> judgement of the verification item. */
    severitySevere: judgement.default("fail"),
    severityMajor: judgement.default("doubt"),
    severityMinor: judgement.default("doubt"),
    /** The verifier should run on a different provider than the worker (falls back to the worker's when none exists). */
    preferDifferentProvider: z.boolean().default(true),

    // ---- advanced ----
    /** One verifier / reviewer round (minutes). */
    roundTimeoutMinutes: z.number().min(1).max(240).default(20),
    /** Chars of a small log / report inlined into the judge prompt (head + tail). */
    excerptChars: z.number().int().min(500).max(200_000).default(6000),
    /** How long a collector waits for the dev server's ready URL (seconds); a verify.json value wins. */
    readyTimeoutSeconds: z.number().min(5).max(3600).default(60),
    /** Where baseline worktrees are created. Empty = env VIBE_WORKTREE_ROOT, else <VIBE_HOME>/worktrees. */
    worktreeRoot: z.string().default(""),
  }),
});

export type VerifySettingsValues = z.output<typeof verifySettings.schema>;
