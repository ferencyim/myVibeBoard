// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Domain types for every table, as zod schemas. Runtime-neutral (client, server and App).
//
// Naming: DB columns are snake_case; domain objects are camelCase. Columns ending in `_json`
// are exposed parsed under the name without the suffix (`ref_images_json` -> `refImages`);
// INTEGER 0/1 flags are exposed as booleans. db/rows.ts performs the mapping generically.

import { z } from "zod";
import {
  DeviceKindSchema,
  EvidenceKindSchema,
  JudgementSchema,
  MaintenanceOutputModeSchema,
  MaintenanceRunStatusSchema,
  MaintenanceTriggerKindSchema,
  PresetEnvironmentKindSchema,
  PresetPermissionModeSchema,
  ProjectTypeSchema,
  RoleHintSchema,
  SessionComplexitySchema,
  SessionRoleSchema,
  SessionStateSchema,
  VerificationKindSchema,
  VerificationModeSchema,
} from "./enums";
import { ModelDefaultsSchema } from "./model-roles";
import { isSafeRepoRelativePath } from "./paths";

const Iso = z.string(); // ISO-8601 UTC
const Hlc = z.string(); // see hlc.ts; "" = never stamped
const Json = z.unknown();

// --- core: project / card ------------------------------------------------------------------

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  prefix: z.string(),
  repoPath: z.string(),
  /** Non-empty, no duplicates; the first entry is the primary type. */
  projectTypes: z
    .array(ProjectTypeSchema)
    .min(1)
    .refine((types) => new Set(types).size === types.length, "projectTypes must not repeat"),
  // COMPAT(project-types): added 2026-10-21, remove after 2027-04-01
  // Always equals projectTypes[0]; old phones (offline db / sync) still read and write only this.
  projectType: ProjectTypeSchema,
  /** Free-text project description (goal, stack); handed to agents as context. */
  description: z.string(),
  /** Requirements document, relative to the repository root (never absolute, never `..`). */
  requirementsPath: z
    .string()
    .refine(isSafeRepoRelativePath, "requirementsPath must be repo-relative"),
  /** WP-108: default preset per model job; missing keys follow the global default. Replaces defaultPresetId. */
  defaultPresets: ModelDefaultsSchema,
  concurrencyLimit: z.number().int().nullable(),
  devices: z.array(z.string()),
  paseoProjectId: z.string().nullable(),
  color: z.string().nullable(),
  nextNumber: z.number().int(),
  createdAt: Iso,
  updatedAt: Iso,
  archivedAt: Iso.nullable(),
  updatedHlc: Hlc,
});
export type Project = z.infer<typeof ProjectSchema>;

export const PresetModelSchema = z.object({
  provider: z.string().trim().min(1),
  // COMPAT: old presets used an empty model to request the provider's catalog default.
  model: z.string(),
  thinking: z.string(),
  permissionMode: PresetPermissionModeSchema,
});
export type PresetModel = z.infer<typeof PresetModelSchema>;
export const PresetModelInputSchema = PresetModelSchema.extend({
  model: z.string().trim().min(1),
});

export const PresetSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  thinking: z.string(),
  permissionMode: PresetPermissionModeSchema,
  /** Ordered candidates; omitted by older replicas. Top-level fields mirror the first. */
  models: z.array(PresetModelSchema).min(1).optional(),
  environmentKind: PresetEnvironmentKindSchema,
  baseBranch: z.string().nullable(),
  /** Runtime environment the agent runs in (e.g. android-emulator, web-dev-server). */
  runtimeEnv: z.string().nullable(),
  instructions: z.string(),
  /** Preset ids to fall back to, in order, when a session on this preset fails; null = none. */
  fallbackPresetIds: z.array(z.string()).nullable(),
  /** Jobs this preset may be picked for (scout / worker / reviewer); [] = unspecified. */
  roleHints: z.array(RoleHintSchema),
  // COMPAT(preset-role-hints): added 2026-10-21, remove after 2027-04-01
  // First entry of roleHints (null when empty); old phones still read and write only this.
  roleHint: z.string().nullable(),
  builtin: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
  updatedHlc: Hlc,
});
export type Preset = z.infer<typeof PresetSchema>;

export const SwitchHistoryEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  at: Iso,
  reason: z.string().optional(),
});
export type SwitchHistoryEntry = z.infer<typeof SwitchHistoryEntrySchema>;

export const AgentSessionSchema = z.object({
  id: z.string(),
  /** null for the long-lived master session. */
  cardId: z.string().nullable(),
  /** The Paseo agent id. */
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  projectId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  thinking: z.string().nullable().optional(),
  candidateIndex: z.number().int().nonnegative().nullable().optional(),
  previousSessionId: z.string().nullable().optional(),
  confirmedAt: Iso.nullable().optional(),
  role: SessionRoleSchema,
  currentProvider: z.string(),
  switchHistory: z.array(SwitchHistoryEntrySchema),
  state: SessionStateSchema,
  waitingSince: Iso.nullable(),
  pendingQuestion: Json.nullable(),
  cacheExpiresAt: Iso.nullable(),
  lastActivityAt: Iso,
  startedAt: Iso,
  endedAt: Iso.nullable(),
  errorMessage: z.string().nullable(),
  /**
   * Set when the session produced no output for too long (stall detector). Not a session state:
   * the state machine is unchanged; cleared as soon as activity resumes or the session ends.
   */
  stalledSince: Iso.nullable(),
  complexity: SessionComplexitySchema.nullable(),
  /** The failed session this one replaced (failure reassignment). */
  reassignedFromSessionId: z.string().nullable(),
  updatedHlc: Hlc,
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

// --- verify (owner: vibe-verify) ------------------------------------------------------------

export const TaskVerificationSchema = z.object({
  id: z.string(),
  cardId: z.null(),
  workspaceId: z.string().min(1),
  confirmedAt: Iso,
  projectId: z.string().nullable(),
  commitHash: z.string(),
  /** null while running. */
  conclusion: JudgementSchema.nullable(),
  verifierAgentId: z.string().nullable(),
  mode: VerificationModeSchema,
  kind: VerificationKindSchema,
  startedAt: Iso,
  finishedAt: Iso.nullable(),
});
export type TaskVerification = z.infer<typeof TaskVerificationSchema>;

export const VerificationItemSchema = z.object({
  id: z.string(),
  verificationId: z.string(),
  kind: VerificationKindSchema,
  position: z.number().int(),
  checkText: z.string(),
  method: z.string(),
  judgement: JudgementSchema.nullable(),
  note: z.string(),
  evidenceIds: z.array(z.string()),
});
export type VerificationItem = z.infer<typeof VerificationItemSchema>;

export const EvidenceFileSchema = z.object({
  id: z.string(),
  verificationId: z.string(),
  itemId: z.string().nullable(),
  kind: EvidenceKindSchema,
  path: z.string(),
  thumbPath: z.string().nullable(),
  sha256: z.string(),
  capturedAt: Iso,
  commitHash: z.string(),
  /** true when produced by a simulator/emulator or a degraded fallback, not real hardware. */
  simulated: z.boolean(),
});
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

// --- context (owner: vibe-context) ----------------------------------------------------------

export const MemoryEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Memory file, relative to the project's .vibe directory. */
  file: z.string(),
  tag: z.string(),
  tokens: z.number().int(),
  createdAt: Iso,
  touchedAt: Iso,
  archived: z.boolean(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// --- scheduler (owner: vibe-scheduler) ------------------------------------------------------

export const ResourceSampleSchema = z.object({
  id: z.number().int(),
  ts: Iso,
  cpu: z.number(),
  mem: z.number(),
  perSession: Json,
  devicePool: Json,
});
export type ResourceSample = z.infer<typeof ResourceSampleSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  kind: DeviceKindSchema,
  name: z.string(),
  meta: Json,
  createdAt: Iso,
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceLeaseSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  id: z.string(),
  deviceId: z.string(),
  cardId: z.string().nullable(),
  sessionId: z.string().nullable(),
  acquiredAt: Iso,
  expiresAt: Iso.nullable(),
  releasedAt: Iso.nullable(),
});
export type DeviceLease = z.infer<typeof DeviceLeaseSchema>;

// --- stats (owner: vibe-stats) --------------------------------------------------------------

export const UsageEventSchema = z.object({
  projectId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  role: SessionRoleSchema.nullable().optional(),
  agentId: z.string().nullable().optional(),
  id: z.number().int(),
  ts: Iso,
  provider: z.string(),
  model: z.string(),
  sessionId: z.string(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  tokensCacheRead: z.number().int(),
  tokensCacheWrite: z.number().int(),
  durationMs: z.number().int().nullable(),
  cost: z.number().nullable(),
  cardId: z.string().nullable(),
  /** Idempotency key: indexer re-reads of the same log line must not double count. */
  dedupeKey: z.string(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

// --- maintain (owner: vibe-maintain) --------------------------------------------------------

export const MaintenanceRuleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  triggerKind: MaintenanceTriggerKindSchema,
  trigger: Json,
  check: Json,
  agent: z.string().nullable(),
  outputMode: MaintenanceOutputModeSchema,
  priority: z.string(),
  dedupeKey: z.string().nullable(),
  dailyCap: z.number().int(),
  enabled: z.boolean(),
  pausedAt: Iso.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  updatedHlc: Hlc,
});
export type MaintenanceRule = z.infer<typeof MaintenanceRuleSchema>;

export const MaintenanceRunSchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  id: z.string(),
  ruleId: z.string(),
  projectId: z.string(),
  triggeredAt: Iso,
  finishedAt: Iso.nullable(),
  status: MaintenanceRunStatusSchema,
  dedupeKey: z.string().nullable(),
  findings: Json,
  cardIds: z.array(z.string()),
});
export type MaintenanceRun = z.infer<typeof MaintenanceRunSchema>;

// --- event bus row --------------------------------------------------------------------------
