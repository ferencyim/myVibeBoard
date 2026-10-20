// Structured replies of a planning session (rules: skills/vibe-master/SKILL.md, plan_discussion).

import { z } from "zod";

const text = z.string().trim().min(1);

export const PlanTurnSchema = z.object({
  /** What the owner reads (markdown). */
  reply: text,
  /** Questions for read-only sub-agents (the plugin runs them and feeds the answers back). */
  research: z.array(z.object({ question: text, scope: z.string().optional() })).max(3).default([]),
  /** The complete current plan; present only when the consensus changed. */
  plan: z
    .object({
      description: text,
      checks: z.array(z.object({ text, method: z.string().optional() })).default([]),
      subCards: z
        .array(z.object({ title: text, description: z.string().optional() }))
        .default([]),
      tags: z.array(text).default([]),
      recommendedPreset: z.string().optional(),
      notes: z.string().optional(),
      /** Files/directories (globs) the plan touches; the scheduler avoids running overlapping cards in parallel. */
      files: z.array(text).default([]),
    })
    .optional(),
  /** A hint for the owner ("the plan can be executed"); never moves anything. */
  ready: z.boolean().default(false),
});
export type PlanTurn = z.infer<typeof PlanTurnSchema>;

export const HandoffSchema = z.object({ summary: text });
export type Handoff = z.infer<typeof HandoffSchema>;
