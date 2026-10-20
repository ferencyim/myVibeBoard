// vibe-board plugin RPC contract (WP-10). Runtime-neutral: imported by the server handlers, the
// client UI (WP-11/14), the App offline interceptor and the sync endpoint (WP-41).
//
// All names are `vibe.<area>.<verb>`. A "card ref" is a card id (ULID) or key (`ABC-12`).
// Errors are thrown by the server as `Error("[<code>] <message>")` with code one of
// not_found | invalid | conflict | illegal_transition | actor_not_allowed | same_column.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { localStatusRpc, replyCheckRpc, replySendRpc, syncExchangeRpc } from "./sync";
import {
  AgentSessionSchema,
  AttachmentSchema,
  AuthorKindSchema,
  CardColumnSchema,
  CardEventSchema,
  CardEventTypeSchema,
  CardPrioritySchema,
  CardViewSchema,
  PlanSnapshotSchema,
  PlanVersionSchema,
  PresetEnvironmentKindSchema,
  PresetPermissionModeSchema,
  PresetSchema,
  ProjectSchema,
  ProjectTypeSchema,
  TagSchema,
  PROJECT_PREFIX_PATTERN,
} from "../vibe/contract";

export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024;
export const CARDS_LIST_DEFAULT_LIMIT = 500;

const cardRef = z.string().min(1);
const nonBlank = z.string().trim().min(1);
const prefixSchema = z.string().regex(PROJECT_PREFIX_PATTERN);
/** Who a UI-originated move is attributed to; the phone may only move draft <-> todo. */
const moveActorSchema = z.enum(["user", "phone"]);

// --- shapes --------------------------------------------------------------------------------

export const cardDetailSchema = z.object({
  card: CardViewSchema,
  events: z.array(CardEventSchema),
  attachments: z.array(AttachmentSchema),
  plans: z.array(PlanVersionSchema),
  /** Sub-cards (cards whose parentCardId is this card). */
  children: z.array(CardViewSchema),
  sessions: z.array(AgentSessionSchema),
});
export type CardDetail = z.infer<typeof cardDetailSchema>;

export const boardCountsSchema = z.object({
  draft: z.number().int(),
  todo: z.number().int(),
  in_progress: z.number().int(),
  verifying: z.number().int(),
  done: z.number().int(),
});
export type BoardCounts = z.infer<typeof boardCountsSchema>;

const projectFields = {
  name: nonBlank,
  repoPath: z.string(),
  projectType: ProjectTypeSchema,
  defaultPresetId: z.string().nullable(),
  concurrencyLimit: z.number().int().min(1).nullable(),
  devices: z.array(z.string()),
  paseoProjectId: z.string().nullable(),
  color: z.string().nullable(),
};

const presetFields = {
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
};

const cardEditable = {
  title: nonBlank,
  description: z.string(),
  priority: CardPrioritySchema,
  acceptance: z.string(),
  /** Attachment ids of the reference images. */
  refImages: z.array(z.string()),
  needsEvidence: z.boolean(),
  presetId: z.string().nullable(),
  parentCardId: z.string().nullable(),
  tagIds: z.array(z.string()),
};

// --- projects ------------------------------------------------------------------------------

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
    projectType: projectFields.projectType.optional(),
    defaultPresetId: projectFields.defaultPresetId.optional(),
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
    projectType: projectFields.projectType.optional(),
    defaultPresetId: projectFields.defaultPresetId.optional(),
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

// --- board / cards -------------------------------------------------------------------------

/** Per-project card counts per column (general board tab, sidebar badge). Archived excluded. */
export const boardSummaryRpc = defineRpc({
  name: "vibe.board.summary",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        projectId: z.string(),
        prefix: z.string(),
        name: z.string(),
        counts: boardCountsSchema,
      }),
    ),
    totals: boardCountsSchema,
  }),
});

export const cardsListRpc = defineRpc({
  name: "vibe.cards.list",
  /** `project` is an id or prefix. `search` matches key, title and description. Cards come
   *  ordered by sortKey (per column the board order). */
  input: z.object({
    project: z.string().optional(),
    column: CardColumnSchema.optional(),
    tagId: z.string().optional(),
    priority: CardPrioritySchema.optional(),
    search: z.string().optional(),
    parentCardId: z.string().optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  output: z.object({ cards: z.array(CardViewSchema), truncated: z.boolean() }),
});

export const cardsGetRpc = defineRpc({
  name: "vibe.cards.get",
  input: z.object({ card: cardRef }),
  output: cardDetailSchema,
});

export const cardsCreateRpc = defineRpc({
  name: "vibe.cards.create",
  /** UI cards start in draft (default) or todo. `project` is an id or prefix. */
  input: z.object({
    project: z.string().min(1),
    title: cardEditable.title,
    description: cardEditable.description.optional(),
    column: z.enum(["draft", "todo"]).optional(),
    priority: cardEditable.priority.optional(),
    acceptance: cardEditable.acceptance.optional(),
    refImages: cardEditable.refImages.optional(),
    needsEvidence: cardEditable.needsEvidence.optional(),
    presetId: cardEditable.presetId.optional(),
    parentCardId: cardEditable.parentCardId.optional(),
    tagIds: cardEditable.tagIds.optional(),
    sortKey: z.string().optional(),
  }),
  output: z.object({ card: CardViewSchema }),
});

export const cardsUpdateRpc = defineRpc({
  name: "vibe.cards.update",
  input: z.object({
    card: cardRef,
    title: cardEditable.title.optional(),
    description: cardEditable.description.optional(),
    priority: cardEditable.priority.optional(),
    acceptance: cardEditable.acceptance.optional(),
    refImages: cardEditable.refImages.optional(),
    needsEvidence: cardEditable.needsEvidence.optional(),
    presetId: cardEditable.presetId.optional(),
    parentCardId: cardEditable.parentCardId.optional(),
    tagIds: cardEditable.tagIds.optional(),
  }),
  output: z.object({ card: CardViewSchema }),
});

export const cardsMoveRpc = defineRpc({
  name: "vibe.cards.move",
  /** Column move validated by the state machine (UI: draft <-> todo, verifying -> done/in_progress
   *  by the user; todo -> in_progress is the dispatcher's). `sortKey` default: end of target. */
  input: z.object({
    card: cardRef,
    to: CardColumnSchema,
    actor: moveActorSchema.optional(),
    reason: z.string().optional(),
    sortKey: z.string().optional(),
  }),
  output: z.object({ card: CardViewSchema }),
});

export const cardsReorderRpc = defineRpc({
  name: "vibe.cards.reorder",
  /** Place a card within its column: `sortKey` explicit, or between `afterCard` and `beforeCard`
   *  (neighbour refs; null/omitted = start/end). */
  input: z.object({
    card: cardRef,
    sortKey: z.string().optional(),
    afterCard: cardRef.nullable().optional(),
    beforeCard: cardRef.nullable().optional(),
  }),
  output: z.object({ card: CardViewSchema }),
});

export const cardsArchiveRpc = defineRpc({
  name: "vibe.cards.archive",
  input: z.object({ card: cardRef, archived: z.boolean().optional() }),
  output: z.object({ card: CardViewSchema }),
});

export const cardsDeleteRpc = defineRpc({
  name: "vibe.cards.delete",
  input: z.object({ card: cardRef }),
  output: z.object({ deleted: z.boolean() }),
});

// --- card events (timeline) ----------------------------------------------------------------

export const eventsListRpc = defineRpc({
  name: "vibe.events.list",
  input: z.object({ card: cardRef }),
  output: z.object({ events: z.array(CardEventSchema) }),
});

export const eventsAddRpc = defineRpc({
  name: "vibe.events.add",
  /** Comment / note on a card. `text` becomes body `{ text }`; pass `body` for structured events. */
  input: z.object({
    card: cardRef,
    type: CardEventTypeSchema.optional(),
    text: z.string().optional(),
    body: z.unknown().optional(),
    authorKind: AuthorKindSchema.optional(),
    author: z.string().optional(),
  }),
  output: z.object({ event: CardEventSchema }),
});

// --- plan versions -------------------------------------------------------------------------

export const plansListRpc = defineRpc({
  name: "vibe.plans.list",
  input: z.object({ card: cardRef }),
  output: z.object({ versions: z.array(PlanVersionSchema) }),
});

export const plansSaveRpc = defineRpc({
  name: "vibe.plans.save",
  /** Appends the next version (1, 2, ...). */
  input: z.object({ card: cardRef, snapshot: PlanSnapshotSchema }),
  output: z.object({ version: PlanVersionSchema }),
});

// --- tags / presets / providers ------------------------------------------------------------

export const tagsListRpc = defineRpc({
  name: "vibe.tags.list",
  input: z.object({}),
  output: z.object({ tags: z.array(TagSchema) }),
});

export const tagsCreateRpc = defineRpc({
  name: "vibe.tags.create",
  input: z.object({ name: nonBlank, evidence: z.boolean().optional() }),
  output: z.object({ tag: TagSchema }),
});

export const tagsDeleteRpc = defineRpc({
  name: "vibe.tags.delete",
  input: z.object({ tagId: z.string() }),
  output: z.object({ deleted: z.boolean() }),
});

export const presetsListRpc = defineRpc({
  name: "vibe.presets.list",
  input: z.object({}),
  output: z.object({ presets: z.array(PresetSchema) }),
});

export const presetsCreateRpc = defineRpc({
  name: "vibe.presets.create",
  input: z.object({
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
  }),
  output: z.object({ preset: PresetSchema }),
});

export const presetsUpdateRpc = defineRpc({
  name: "vibe.presets.update",
  input: z.object({
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
        models: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ),
  }),
});

// --- attachments (reference images, files) -------------------------------------------------

export const attachmentsListRpc = defineRpc({
  name: "vibe.attachments.list",
  input: z.object({ card: cardRef }),
  output: z.object({ attachments: z.array(AttachmentSchema) }),
});

export const attachmentsUploadRpc = defineRpc({
  name: "vibe.attachments.upload",
  /** `asRefImage` also appends the new attachment id to the card's refImages. */
  input: z.object({
    card: cardRef,
    fileName: nonBlank,
    mime: z.string().optional(),
    base64: z.string(),
    cardEventId: z.string().optional(),
    asRefImage: z.boolean().optional(),
  }),
  output: z.object({ attachment: AttachmentSchema }),
});

export const attachmentsDownloadRpc = defineRpc({
  name: "vibe.attachments.download",
  input: z.object({ attachmentId: z.string() }),
  output: z.object({ attachment: AttachmentSchema, base64: z.string() }),
});

export const attachmentsDeleteRpc = defineRpc({
  name: "vibe.attachments.delete",
  /** Also removes the id from the owning card's refImages. */
  input: z.object({ attachmentId: z.string() }),
  output: z.object({ deleted: z.boolean() }),
});

// --- sessions (read only; written by WP-12 lifecycle) ---------------------------------------

export const sessionsListRpc = defineRpc({
  name: "vibe.sessions.list",
  input: z.object({ card: cardRef.optional() }),
  output: z.object({ sessions: z.array(AgentSessionSchema) }),
});

// --- dispatch / lifecycle (WP-12) ------------------------------------------------------------

export const cardsDispatchRpc = defineRpc({
  name: "vibe.cards.dispatch",
  /** todo -> in_progress: creates the worktree and starts the worker session from the card's
   *  preset (or `presetId`). Fails with [illegal_transition] unless the card is in todo. */
  input: z.object({
    card: cardRef,
    presetId: z.string().optional(),
    extraInstructions: z.string().optional(),
  }),
  output: z.object({ card: CardViewSchema, session: AgentSessionSchema }),
});

export const sessionsRecordSwitchRpc = defineRpc({
  name: "vibe.sessions.record_switch",
  /** The agent was continued on another provider (switch-provider returned `toAgentId`):
   *  records the switch on the card and moves the session to the new agent. */
  input: z.object({
    fromAgentId: z.string().min(1),
    toAgentId: z.string().min(1),
    provider: z.string().min(1),
    reason: z.string().optional(),
  }),
  output: z.object({ session: AgentSessionSchema.nullable() }),
});

export const VIBE_BOARD_RPCS = {
  projectsListRpc,
  projectsCreateRpc,
  projectsUpdateRpc,
  paseoProjectsListRpc,
  boardSummaryRpc,
  cardsListRpc,
  cardsGetRpc,
  cardsCreateRpc,
  cardsUpdateRpc,
  cardsMoveRpc,
  cardsReorderRpc,
  cardsArchiveRpc,
  cardsDeleteRpc,
  eventsListRpc,
  eventsAddRpc,
  plansListRpc,
  plansSaveRpc,
  tagsListRpc,
  tagsCreateRpc,
  tagsDeleteRpc,
  presetsListRpc,
  presetsCreateRpc,
  presetsUpdateRpc,
  presetsDeleteRpc,
  providersCatalogRpc,
  attachmentsListRpc,
  attachmentsUploadRpc,
  attachmentsDownloadRpc,
  attachmentsDeleteRpc,
  sessionsListRpc,
  cardsDispatchRpc,
  sessionsRecordSwitchRpc,
  syncExchangeRpc,
  replyCheckRpc,
  replySendRpc,
  localStatusRpc,
} as const;

export * from "./sync";
export * from "./verify";
