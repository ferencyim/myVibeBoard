import { z } from "zod";

const text = z.string().trim().min(1);

const MemoryEntryInput = z.object({ tag: z.string().default(""), body: text });

/** task_done: what to write back into the project memory. Everything is optional. */
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
