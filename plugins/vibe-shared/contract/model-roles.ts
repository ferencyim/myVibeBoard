// The seven model jobs of a card (WP-108) and where a job's preset comes from: the card's own pick,
// else the project default, else the global default. Pure; shared by the daemon plugins, the board
// UI and the App's offline replica.

import { z } from "zod";
import type { RoleHint } from "./enums";
import type { CardView } from "./model";

export const MODEL_ROLES = [
  "scout",
  "planner",
  "plan_reviewer",
  "worker",
  "subagent",
  "reviewer",
  "verifier",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const ModelRoleSchema = z.enum(MODEL_ROLES);

/** Default preset per job; a missing key = not set (a project then follows the global default). */
export const ModelDefaultsSchema = z.object({
  scout: z.string().optional(),
  planner: z.string().optional(),
  plan_reviewer: z.string().optional(),
  worker: z.string().optional(),
  subagent: z.string().optional(),
  reviewer: z.string().optional(),
  verifier: z.string().optional(),
});
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

export type CardModelField =
  | "scoutPresetId"
  | "plannerPresetId"
  | "planReviewerPresetId"
  | "presetId"
  | "subagentPresetId"
  | "reviewerPresetId"
  | "verifierPresetId";

/** The card field that holds each job's pick. `presetId` is the main agent. */
export const CARD_MODEL_FIELD: Record<ModelRole, CardModelField> = {
  scout: "scoutPresetId",
  planner: "plannerPresetId",
  plan_reviewer: "planReviewerPresetId",
  worker: "presetId",
  subagent: "subagentPresetId",
  reviewer: "reviewerPresetId",
  verifier: "verifierPresetId",
};

/** The preset purpose the pickers filter by. */
export const MODEL_ROLE_HINT: Record<ModelRole, RoleHint> = {
  scout: "scout",
  planner: "planner",
  plan_reviewer: "reviewer",
  worker: "worker",
  subagent: "worker",
  reviewer: "reviewer",
  verifier: "verifier",
};

/**
 * Jobs that are skipped when the card has no pick (不探路 / 不复核): their defaults only prefill new
 * cards. Every other job falls back to the defaults at run time too.
 */
export const SKIPPABLE_ROLES: readonly ModelRole[] = ["scout", "reviewer"];

export type ModelSource = "card" | "project" | "global";

export interface ResolvedModel {
  presetId: string | null;
  source: ModelSource | null;
}

/** Keeps the known jobs with a non-empty preset id (input from the UI, settings or a JSON column). */
export function cleanDefaults(value: unknown): ModelDefaults {
  const parsed = ModelDefaultsSchema.safeParse(value);
  if (!parsed.success) return {};
  const out: ModelDefaults = {};
  for (const role of MODEL_ROLES) {
    const id = parsed.data[role]?.trim();
    if (id) out[role] = id;
  }
  return out;
}

/**
 * The preset a job runs with: the card's pick, then the project default, then the global default.
 * `exists` skips an id whose preset was deleted. With a card given, a skippable job without a pick
 * resolves to nothing (the card said "do not"); without a card (a new card) the defaults apply.
 */
export function resolveModel(
  role: ModelRole,
  card: Partial<Pick<CardView, CardModelField>> | null | undefined,
  project: { defaultPresets: ModelDefaults } | null | undefined,
  global: ModelDefaults | null | undefined,
  exists: (id: string) => boolean = () => true,
): ResolvedModel {
  const own = card?.[CARD_MODEL_FIELD[role]];
  if (own && exists(own)) return { presetId: own, source: "card" };
  if (card && SKIPPABLE_ROLES.includes(role)) return { presetId: null, source: null };
  const fromProject = project?.defaultPresets[role];
  if (fromProject && exists(fromProject)) return { presetId: fromProject, source: "project" };
  const fromGlobal = global?.[role];
  if (fromGlobal && exists(fromGlobal)) return { presetId: fromGlobal, source: "global" };
  return { presetId: null, source: null };
}

/** Card fields a new card gets from the defaults, for the jobs the caller left open (`undefined`). */
export function prefillModels(
  given: Partial<Record<CardModelField, string | null | undefined>>,
  project: { defaultPresets: ModelDefaults } | null | undefined,
  global: ModelDefaults | null | undefined,
  exists: (id: string) => boolean = () => true,
): Partial<Record<CardModelField, string>> {
  const out: Partial<Record<CardModelField, string>> = {};
  for (const role of MODEL_ROLES) {
    const field = CARD_MODEL_FIELD[role];
    if (given[field] !== undefined) continue;
    const { presetId } = resolveModel(role, null, project, global, exists);
    if (presetId) out[field] = presetId;
  }
  return out;
}
