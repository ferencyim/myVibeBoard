// Structured replies of a planning session (format: prompt master.plan.system, fixed suffix).

import { z } from "zod";
import { subtaskListError } from "../vibe/contract";

const text = z.string().trim().min(1);

/** WP-106: one sub-agent task of the plan; `preset` is a preset name (unknown = default model). */
export const PlanSubtaskSchema = z.object({
  id: text,
  title: text,
  goal: z.string().default(""),
  method: z.string().default(""),
  notes: z.string().default(""),
  acceptance: z.string().default(""),
  files: z.array(text).default([]),
  dependsOn: z.array(text).default([]),
  preset: z.string().nullish(),
});
export type PlanSubtask = z.infer<typeof PlanSubtaskSchema>;

export const PlanTurnSchema = z.object({
  /** What the owner reads in the plan chat (markdown): answers, questions, objections. */
  reply: text,
  /** Questions for read-only scouts (run on the card's scout model, answers fed back). */
  research: z.array(z.object({ question: text, scope: z.string().optional() })).max(3).default([]),
  /** The complete current plan; present only when it changed. */
  plan: z
    .object({
      text,
      /** Files/directories (globs) the plan touches; the scheduler avoids running overlapping cards in parallel. */
      files: z.array(text).default([]),
      /** WP-106: the work split into 1..N sub-agent tasks (the main agent coordinates them). */
      subtasks: z.array(PlanSubtaskSchema).optional(),
    })
    .superRefine((plan, ctx) => {
      const error = plan.subtasks && subtaskListError(plan.subtasks.map((s) => ({ ...s, presetId: null })));
      if (error) ctx.addIssue({ code: "custom", path: ["subtasks"], message: error });
    })
    .optional(),
  /** The complete acceptance criteria (one per line); present only when they changed. */
  acceptance: z.string().optional(),
  /** Suggested new title / description; the owner accepts it in the plan chat. */
  proposal: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      rationale: z.string().default(""),
    })
    .nullish(),
});
export type PlanTurn = z.infer<typeof PlanTurnSchema>;
