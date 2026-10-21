// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Domain types for every table, as zod schemas. Runtime-neutral (client, server and App).
//
// Naming: DB columns are snake_case; domain objects are camelCase. Columns ending in `_json`
// are exposed parsed under the name without the suffix (`ref_images_json` -> `refImages`);
// INTEGER 0/1 flags are exposed as booleans. db/rows.ts performs the mapping generically.

import { z } from "zod";
import {
  AuthorKindSchema,
  CardColumnSchema,
  CardEventTypeSchema,
  CardOriginSchema,
  CardPrioritySchema,
  ChatKindSchema,
  DeviceKindSchema,
  EvidenceKindSchema,
  JudgementSchema,
  MaintenanceOutputModeSchema,
  MaintenanceRunStatusSchema,
  MaintenanceTriggerKindSchema,
  PresetEnvironmentKindSchema,
  PresetPermissionModeSchema,
  ProjectTypeSchema,
  ProposalStatusSchema,
  RoleHintSchema,
  SessionComplexitySchema,
  SessionRoleSchema,
  SessionStateSchema,
  VerificationKindSchema,
  VerificationModeSchema,
} from "./enums";
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
  requirementsPath: z.string().refine(isSafeRepoRelativePath, "requirementsPath must be repo-relative"),
  defaultPresetId: z.string().nullable(),
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

export const CardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  number: z.number().int(),
  key: z.string(),
  title: z.string().min(1),
  description: z.string(),
  column: CardColumnSchema,
  sortKey: z.string(),
  priority: CardPrioritySchema,
  acceptance: z.string(),
  refImages: z.array(z.string()),
  needsEvidence: z.boolean(),
  presetId: z.string().nullable(),
  suggestedPresetId: z.string().nullable(),
  /** Preset used to review this card's result; null = default. Phone-writable. */
  reviewerPresetId: z.string().nullable(),
  worktree: z.string().nullable(),
  origin: CardOriginSchema,
  /** For origin=maintenance: the maintenance_rule id that produced the card. */
  originRef: z.string().nullable(),
  /** Open maintenance cards with the same dedupe key get notes appended instead of a new card. */
  dedupeKey: z.string().nullable(),
  planSessionId: z.string().nullable(),
  parentCardId: z.string().nullable(),
  archivedAt: Iso.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
  updatedHlc: Hlc,
});
export type Card = z.infer<typeof CardSchema>;

/** Card plus its tag ids (card_tag join), as returned by getCard/listCards. */
export const CardViewSchema = CardSchema.extend({ tags: z.array(z.string()) });
export type CardView = z.infer<typeof CardViewSchema>;

export const CardEventSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  type: CardEventTypeSchema,
  authorKind: AuthorKindSchema,
  author: z.string(),
  body: Json,
  createdAt: Iso,
  updatedHlc: Hlc,
});
export type CardEvent = z.infer<typeof CardEventSchema>;

/** Body of a `chat` card event (author kind: user/master/executor/reviewer/scout/system). */
export const ChatEventBodySchema = z.object({
  text: z.string(),
  /** agent_session / Paseo agent the message came from, if any. */
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  kind: ChatKindSchema.optional(),
});
export type ChatEventBody = z.infer<typeof ChatEventBodySchema>;

/** Card fields a proposal may change. */
export const ProposalChangesSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  acceptance: z.string().optional(),
});
export type ProposalChanges = z.infer<typeof ProposalChangesSchema>;

/** Body of a `proposal` card event; `status` is the only part that changes after creation. */
export const ProposalEventBodySchema = z.object({
  changes: ProposalChangesSchema,
  rationale: z.string(),
  status: ProposalStatusSchema,
  /** Who accepted/rejected it and when (set with the status change). */
  resolvedBy: z.string().optional(),
  resolvedAt: Iso.optional(),
});
export type ProposalEventBody = z.infer<typeof ProposalEventBodySchema>;

export const PlanSnapshotSchema = z.object({
  description: z.string(),
  checks: z.array(z.object({ text: z.string(), method: z.string().optional() })),
  subCards: z.array(z.object({ title: z.string(), description: z.string().optional() })),
  tags: z.array(z.string()),
  recommendedPresetId: z.string().nullable(),
  notes: z.string().optional(),
  /** Files/directories (globs) the plan touches; the scheduler uses them to avoid parallel conflicts. */
  files: z.array(z.string()).optional(),
});
export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;

export const PlanVersionSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  version: z.number().int().min(1),
  snapshot: PlanSnapshotSchema,
  createdAt: Iso,
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

export const PresetSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  provider: z.string(),
  model: z.string(),
  thinking: z.string(),
  permissionMode: PresetPermissionModeSchema,
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

export const TagSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** Default for card.needs_evidence when this tag is applied. */
  evidence: z.boolean(),
  builtin: z.boolean(),
  updatedHlc: Hlc,
});
export type Tag = z.infer<typeof TagSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  cardEventId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  createdAt: Iso,
});
export type Attachment = z.infer<typeof AttachmentSchema>;

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

export const GitSnapshotSchema = z.object({
  projectId: z.string(),
  branch: z.string(),
  ahead: z.number().int(),
  behind: z.number().int(),
  dirtyFiles: z.number().int(),
  diffStat: z.string(),
  takenAt: Iso,
});
export type GitSnapshot = z.infer<typeof GitSnapshotSchema>;

// --- verify (owner: vibe-verify) ------------------------------------------------------------

export const VerificationSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  commitHash: z.string(),
  /** null while running. */
  conclusion: JudgementSchema.nullable(),
  verifierAgentId: z.string().nullable(),
  mode: VerificationModeSchema,
  kind: VerificationKindSchema,
  startedAt: Iso,
  finishedAt: Iso.nullable(),
});
export type Verification = z.infer<typeof VerificationSchema>;

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

export const SyncFieldMetaSchema = z.object({
  tableName: z.string(),
  rowId: z.string(),
  columnName: z.string(),
  hlc: Hlc,
  deviceId: z.string(),
});
export type SyncFieldMeta = z.infer<typeof SyncFieldMetaSchema>;

export const SyncTombstoneSchema = z.object({
  tableName: z.string(),
  rowId: z.string(),
  hlc: Hlc,
  deviceId: z.string(),
  deletedAt: Iso,
});
export type SyncTombstone = z.infer<typeof SyncTombstoneSchema>;
