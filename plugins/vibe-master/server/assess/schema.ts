// Structured outputs of the master (memory update) and the planner's proposals. Every reply is validated with these schemas before
// anything is written; invalid replies are retried once and then recorded as a failure.

import { z } from "zod";

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

