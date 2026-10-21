// The structured outputs the master returns. Every reply is validated with these schemas before
// anything is written; invalid replies are retried once and then recorded as a failure.

import { z } from "zod";

export const SIZES = ["S", "M", "L", "XL"] as const;
export type Size = (typeof SIZES)[number];

const text = z.string().trim().min(1);

/**
 * The master's suggestion for the card's own fields. The master never edits them itself: the owner
 * accepts or rejects the proposal in the card chat. A proposal without any changed field is ignored.
 */
export const ProposalSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  acceptance: z.string().optional(),
  rationale: text,
});
export type ProposalInput = z.infer<typeof ProposalSchema>;
/** A malformed proposal is dropped instead of failing the whole reply. */
export const OptionalProposal = ProposalSchema.optional().catch(undefined);

/** assess_draft: evaluation of a draft card (also the body of the `evaluation` card event). */
export const AssessmentSchema = z
  .object({
    clarity: z.object({
      status: z.enum(["clear", "needs_clarification"]),
      summary: text,
      /** Questions the owner has to answer; required when status is needs_clarification. */
      questions: z.array(text).default([]),
    }),
    /** Existing cards that duplicate, conflict with or relate to this draft. */
    related: z
      .array(
        z.object({
          card: text,
          relation: z.enum(["duplicate", "conflict", "related"]),
          note: z.string().default(""),
        }),
      )
      .default([]),
    split: z.object({
      suggested: z.boolean(),
      reason: z.string().default(""),
      subCards: z
        .array(z.object({ title: text, description: z.string().optional() }))
        .default([]),
    }),
    /** Suggested tags from the project's fixed vocabulary. */
    tags: z.array(text).default([]),
    estimate: z.object({ size: z.enum(SIZES), rationale: text }),
    recommendation: z.object({
      /** Provider/agent id, any provider id listed in the project block (for example claude or codex). */
      agent: text,
      /** Name or id of one of the listed presets; the plugin resolves it to card.suggested_preset_id. */
      preset: z.string().optional(),
      model: z.string().optional(),
      thinking: z.string().optional(),
      reason: text,
    }),
    /** Optional: should a model review the result? The owner picks the reviewer on the card. */
    reviewer: z
      .object({
        recommend: z.boolean(),
        /** Name or id of one of the listed presets (preferably a different provider than the worker). */
        presetName: z.string().optional(),
        reason: z.string().default(""),
      })
      .optional(),
    risks: z.array(text).default([]),
    /** Files/directories (globs, repo-relative) the card is expected to touch; empty when unknown. */
    files: z.array(text).default([]),
    /** Acceptance checks, written to the card (plan version) for vibe-verify. */
    checks: z.array(z.object({ text, method: z.string().optional() })).min(1),
    /** What the owner reads in the card chat (markdown, 2 to 6 sentences); generated from the fields when absent. */
    verdict: z.string().optional(),
    /** Suggested new title / description / acceptance; the owner accepts it in the chat. */
    proposal: OptionalProposal,
  })
  .refine((a) => a.clarity.status === "clear" || a.clarity.questions.length > 0, {
    message: "clarity.questions must list at least one question when status is needs_clarification",
    path: ["clarity", "questions"],
  });
export type Assessment = z.infer<typeof AssessmentSchema>;

/** session_help: advice for a worker that asked a question. Never answers on the owner's behalf. */
export const HelpSchema = z.object({
  summary: text,
  suggestedAnswer: z.string().default(""),
  confidence: z.enum(["low", "medium", "high"]),
  needsOwner: z.boolean(),
});
export type Help = z.infer<typeof HelpSchema>;

const MemoryEntryInput = z.object({ tag: z.string().default(""), body: text });

/** card_done: what to write back into the project memory. Everything is optional. */
export const MemoryUpdateSchema = z.object({
  summary: text,
  /** Complete new body of PROJECT_STATE.md (replaces the old one). */
  state: z.string().optional(),
  decisions: z
    .array(MemoryEntryInput.extend({ supersedes: z.array(z.string()).default([]) }))
    .default([]),
  lessons: z.array(MemoryEntryInput).default([]),
  index: z.array(MemoryEntryInput).default([]),
  /** Entries that are duplicated, outdated or contradicted: moved to the archive file. */
  archive: z
    .array(z.object({ file: z.enum(["DECISIONS.md", "LESSONS.md", "INDEX.md"]), id: text }))
    .default([]),
  /**
   * Optional: complete new content of the project's requirements document. Written and committed by
   * the plugin only when the owner enabled requirements maintenance.
   */
  requirementsUpdate: z.object({ content: text, summary: text }).optional(),
});
export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

export type ReplyKind = "assess_draft" | "session_help" | "card_done";
export const REPLY_SCHEMAS = {
  assess_draft: AssessmentSchema,
  session_help: HelpSchema,
  card_done: MemoryUpdateSchema,
} as const;
