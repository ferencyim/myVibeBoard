import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  ModelDefaultsSchema,
  PromptDefSchema,
  PresetEnvironmentKindSchema,
  PresetPermissionModeSchema,
  PresetModelInputSchema,
  PresetSchema,
  ProjectSchema,
  ProjectTypeSchema,
  RoleHintSchema,
  PROJECT_PREFIX_PATTERN,
  ROLE_HINTS,
  isSafeRepoRelativePath,
} from "../vibe/contract";
const nonBlank = z.string().trim().min(1);
const prefixSchema = z.string().regex(PROJECT_PREFIX_PATTERN);
const projectFields = {
  name: nonBlank,
  repoPath: z.string(),
  /** Non-empty, no repeats; the first is the primary type. Wins over `projectType`. */
  projectTypes: z
    .array(ProjectTypeSchema)
    .min(1)
    .refine((types) => new Set(types).size === types.length, "projectTypes must not repeat"),
  // COMPAT(project-types): added 2026-10-21, remove after 2027-04-01
  projectType: ProjectTypeSchema,
  description: z.string(),
  /** Requirements document, relative to the repository root. */
  requirementsPath: z
    .string()
    .refine(isSafeRepoRelativePath, "must be relative to the repository root"),
  /** WP-108: default preset per model job; a missing job follows the global default. */
  defaultPresets: ModelDefaultsSchema,
  concurrencyLimit: z.number().int().min(1).nullable(),
  devices: z.array(z.string()),
  paseoProjectId: z.string().nullable(),
  color: z.string().nullable(),
};

export const PRESET_ROLE_HINTS = ROLE_HINTS;

const presetFields = {
  models: z.array(PresetModelInputSchema).min(1),
  name: nonBlank,
  provider: nonBlank,
  model: nonBlank,
  thinking: z.string(),
  permissionMode: PresetPermissionModeSchema,
  environmentKind: PresetEnvironmentKindSchema,
  baseBranch: z.string().nullable(),
  runtimeEnv: z.string().nullable(),
  instructions: z.string(),
  /** Ordered failover chain: preset ids to continue on when a session on this preset fails. */
  fallbackPresetIds: z.array(z.string()).nullable(),
  /** Purposes (worker | scout | reviewer | planner | verifier); [] = unspecified. Wins over `roleHint`. */
  roleHints: z.array(RoleHintSchema),
  // COMPAT(preset-role-hints): added 2026-10-21, remove after 2027-04-01
  roleHint: z.enum(PRESET_ROLE_HINTS).nullable(),
};

export const projectsListRpc = defineRpc({
  name: "vibe.projects.list",
  input: z.object({ includeArchived: z.boolean().optional() }),
  output: z.object({ projects: z.array(ProjectSchema) }),
});

export const projectsCreateRpc = defineRpc({
  name: "vibe.projects.create",
  input: z.object({
    name: projectFields.name,
    prefix: prefixSchema,
    repoPath: projectFields.repoPath.default(""),
    projectTypes: projectFields.projectTypes.optional(),
    projectType: projectFields.projectType.optional(),
    description: projectFields.description.optional(),
    requirementsPath: projectFields.requirementsPath.optional(),
    defaultPresets: projectFields.defaultPresets.optional(),
    concurrencyLimit: projectFields.concurrencyLimit.optional(),
    devices: projectFields.devices.optional(),
    paseoProjectId: projectFields.paseoProjectId.optional(),
    color: projectFields.color.optional(),
  }),
  output: z.object({ project: ProjectSchema }),
});

export const projectsUpdateRpc = defineRpc({
  name: "vibe.projects.update",
  /** `project` is an id or prefix. The prefix itself cannot change. */
  input: z.object({
    project: z.string().min(1),
    name: projectFields.name.optional(),
    repoPath: projectFields.repoPath.optional(),
    projectTypes: projectFields.projectTypes.optional(),
    projectType: projectFields.projectType.optional(),
    description: projectFields.description.optional(),
    requirementsPath: projectFields.requirementsPath.optional(),
    defaultPresets: projectFields.defaultPresets.optional(),
    concurrencyLimit: projectFields.concurrencyLimit.optional(),
    devices: projectFields.devices.optional(),
    paseoProjectId: projectFields.paseoProjectId.optional(),
    color: projectFields.color.optional(),
    archived: z.boolean().optional(),
  }),
  output: z.object({ project: ProjectSchema }),
});

/** Paseo's own projects, for linking `paseoProjectId`. */
export const paseoProjectsListRpc = defineRpc({
  name: "vibe.paseo_projects.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        rootPath: z.string().optional(),
        kind: z.string().optional(),
      }),
    ),
  }),
});

export const defaultsGetRpc = defineRpc({
  name: "vibe.defaults.get",
  /** The global default model per job (the project level is project.defaultPresets). */
  input: z.object({}),
  output: z.object({ global: ModelDefaultsSchema }),
});

export const defaultsSetRpc = defineRpc({
  name: "vibe.defaults.set",
  /** Replaces the global defaults; a missing job = no global default. */
  input: z.object({ global: ModelDefaultsSchema }),
  output: z.object({ global: ModelDefaultsSchema }),
});

export const presetsListRpc = defineRpc({
  name: "vibe.presets.list",
  input: z.object({}),
  output: z.object({ presets: z.array(PresetSchema) }),
});

export const presetsCreateRpc = defineRpc({
  name: "vibe.presets.create",
  input: z.object({
    models: presetFields.models.optional(),
    name: presetFields.name,
    provider: presetFields.provider,
    model: presetFields.model,
    thinking: presetFields.thinking.optional(),
    permissionMode: presetFields.permissionMode.optional(),
    environmentKind: presetFields.environmentKind.optional(),
    baseBranch: presetFields.baseBranch.optional(),
    runtimeEnv: presetFields.runtimeEnv.optional(),
    instructions: presetFields.instructions.optional(),
    fallbackPresetIds: presetFields.fallbackPresetIds.optional(),
    roleHints: presetFields.roleHints.optional(),
    roleHint: presetFields.roleHint.optional(),
  }),
  output: z.object({ preset: PresetSchema }),
});

export const presetsUpdateRpc = defineRpc({
  name: "vibe.presets.update",
  input: z.object({
    models: presetFields.models.optional(),
    presetId: z.string(),
    name: presetFields.name.optional(),
    provider: presetFields.provider.optional(),
    model: presetFields.model.optional(),
    thinking: presetFields.thinking.optional(),
    permissionMode: presetFields.permissionMode.optional(),
    environmentKind: presetFields.environmentKind.optional(),
    baseBranch: presetFields.baseBranch.optional(),
    runtimeEnv: presetFields.runtimeEnv.optional(),
    instructions: presetFields.instructions.optional(),
    fallbackPresetIds: presetFields.fallbackPresetIds.optional(),
    roleHints: presetFields.roleHints.optional(),
    roleHint: presetFields.roleHint.optional(),
  }),
  output: z.object({ preset: PresetSchema }),
});

export const presetsDeleteRpc = defineRpc({
  name: "vibe.presets.delete",
  input: z.object({ presetId: z.string() }),
  output: z.object({ deleted: z.boolean() }),
});

/** Providers/models the daemon can run (preset picker). */
export const providersCatalogRpc = defineRpc({
  name: "vibe.providers.catalog",
  input: z.object({}),
  output: z.object({
    providers: z.array(
      z.object({
        id: z.string(),
        available: z.boolean(),
        models: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            /** Thinking levels this model accepts; absent/empty = no choice. */
            thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
            defaultThinkingOptionId: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
});

const requirementsDocShape = {
  /** Repo-relative path, forward slashes. */
  path: z.string(),
  exists: z.boolean(),
  /** "" when the file does not exist yet. */
  content: z.string(),
};

export const requirementsGetRpc = defineRpc({
  name: "vibe.requirements.get",
  input: z.object({ project: z.string().min(1) }),
  output: z.object(requirementsDocShape),
});

export const requirementsSaveRpc = defineRpc({
  name: "vibe.requirements.save",
  /** Writes the file and commits only that file (no push). `committed:false` = content unchanged. */
  input: z.object({ project: z.string().min(1), content: z.string() }),
  output: z.object({
    ...requirementsDocShape,
    committed: z.boolean(),
    commit: z.string().nullable(),
    created: z.boolean(),
  }),
});

export const promptInfoSchema = PromptDefSchema.extend({
  globalOverride: z.string().nullable(),
  /** Only filled when a project was asked for. */
  projectOverride: z.string().nullable(),
  source: z.enum(["default", "global", "project"]),
  effectiveText: z.string(),
  overriddenProjects: z.array(z.string()),
});

const promptScope = z.string().min(1).nullable().optional();

export const promptsListRpc = defineRpc({
  name: "vibe.prompts.list",
  input: z.object({ projectId: promptScope }),
  output: z.object({
    prompts: z.array(promptInfoSchema),
    /** Unarchived projects, for the scope switcher. */
    projects: z.array(z.object({ id: z.string(), name: z.string(), prefix: z.string() })),
    /** Overrides whose prompt was merged or removed; shown as stale on the Agent behaviour page. */
    orphans: z
      .array(z.object({ key: z.string(), projectId: z.string().nullable() }))
      .default([]),
  }),
});

/** Blank text clears the override. `projectId` null/omitted = global. */
export const promptsSetRpc = defineRpc({
  name: "vibe.prompts.set",
  input: z.object({ key: z.string().min(1), text: z.string(), projectId: promptScope }),
  output: z.object({ ok: z.literal(true) }),
});

export const promptsClearRpc = defineRpc({
  name: "vibe.prompts.clear",
  input: z.object({ key: z.string().min(1), projectId: promptScope }),
  output: z.object({ ok: z.literal(true) }),
});
