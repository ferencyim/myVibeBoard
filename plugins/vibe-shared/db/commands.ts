// Command layer: the only sanctioned way to write project/card/card_event/agent_session/
// preset/tag/plan_version (docs/vibe/ARCHITECTURE.md 3.4). Every command, in ONE write
// transaction:
//   1. validates input and the state machine,
//   2. writes the rows,
//   3. stamps an HLC (updated_hlc + field-level sync_meta for syncable tables, tombstones for
//      deletes),
//   4. publishes the matching vibe_event rows.
// Plugins never write these tables with raw SQL.

import {
  CARD_KEY_PATTERN,
  DEFAULT_REQUIREMENTS_PATH,
  PROJECT_PREFIX_PATTERN,
  ROLE_HINTS,
  type AuthorKind,
  type CardColumn,
  type CardEventType,
  type CardOrigin,
  type CardPriority,
  type ChatThread,
  type PresetEnvironmentKind,
  type ChatKind,
  type PresetPermissionMode,
  type ProjectType,
  type RoleHint,
  type SessionComplexity,
  type SessionRole,
  type SessionState,
} from "../contract/enums";
import { type Hlc, tickHlc } from "../contract/hlc";
import { newId } from "../contract/ids";
import {
  AgentSessionSchema,
  CardEventSchema,
  CardSchema,
  GitSnapshotSchema,
  PlanSnapshotSchema,
  PlanVersionSchema,
  PresetSchema,
  ProjectSchema,
  ProposalChangesSchema,
  ProposalEventBodySchema,
  TagSchema,
  type AgentSession,
  type CardEvent,
  type CardView,
  type ChatEventBody,
  type GitSnapshot,
  type PlanSnapshot,
  type PlanVersion,
  type Preset,
  type ProposalChanges,
  type ProposalEventBody,
  type Project,
  type Tag,
} from "../contract/model";
import {
  PROMPT_OVERRIDE_MAX_CHARS,
  PromptDefSchema,
  composePrompt,
  promptOverrideId,
  renderPromptTemplate,
  type PromptDef,
  type PromptInfo,
  type PromptSource,
} from "../contract/prompts";
import { sortKeyAfter } from "../contract/sort-key";
import {
  type MoveActor,
  StateMachineError,
  assertSessionTransition,
  assertTransition,
  canCreateIn,
} from "../contract/state-machine";
import { isSafeRepoRelativePath } from "../contract/paths";
import { syncSpec } from "../contract/sync-spec";
import { ACTIVITY_COLUMN, activityTabsOf } from "../contract/card-tabs";
import { publishEvent } from "./events";
import { decodeRow, decodeRows } from "./rows";
import type { Row, SqlParam, VibeDb } from "./sqlite";

export class CommandError extends Error {
  readonly code: "not_found" | "invalid" | "conflict";
  constructor(code: CommandError["code"], message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface StoreOptions {
  now?: () => Date;
  /** Sync device id; default: generated once and kept in vibe_meta. Phone replicas pass their own. */
  deviceId?: string;
}

// --- input shapes -----------------------------------------------------------------------------

export interface CreateProjectInput {
  name: string;
  prefix: string;
  repoPath: string;
  /** Non-empty, deduplicated; the first is the primary type. Wins over `projectType`. */
  projectTypes?: ProjectType[];
  // COMPAT(project-types): added 2026-10-21, remove after 2027-04-01
  // Old replicas send only this; it becomes projectTypes = [projectType].
  projectType?: ProjectType;
  description?: string;
  /** Repo-relative requirements file; default PRODUCT-REQUIREMENTS.md. */
  requirementsPath?: string;
  defaultPresetId?: string | null;
  concurrencyLimit?: number | null;
  devices?: string[];
  paseoProjectId?: string | null;
  color?: string | null;
}
export type UpdateProjectInput = Partial<Omit<CreateProjectInput, "prefix">> & {
  archived?: boolean;
};

export interface CreatePresetInput {
  /** Sync materialization: keep the id a replica generated offline. */
  id?: string;
  name: string;
  provider: string;
  model: string;
  thinking?: string;
  permissionMode?: PresetPermissionMode;
  environmentKind?: PresetEnvironmentKind;
  baseBranch?: string | null;
  runtimeEnv?: string | null;
  instructions?: string;
  /** Preset ids tried in order when a session on this preset fails. */
  fallbackPresetIds?: string[] | null;
  /** Jobs the preset may be picked for; [] = unspecified. Wins over `roleHint`. */
  roleHints?: RoleHint[];
  // COMPAT(preset-role-hints): added 2026-10-21, remove after 2027-04-01
  // Old replicas send only this; it becomes roleHints = [roleHint] (unknown values: []).
  roleHint?: string | null;
  builtin?: boolean;
}
export type UpdatePresetInput = Partial<CreatePresetInput>;

export interface CreateCardInput {
  /** Sync materialization: keep the id/creation time a replica generated offline. */
  id?: string;
  createdAt?: string;
  projectId: string;
  title: string;
  description?: string;
  column?: CardColumn;
  priority?: CardPriority;
  acceptance?: string;
  refImages?: string[];
  /** Default: true if any applied tag defaults to evidence. */
  needsEvidence?: boolean;
  presetId?: string | null;
  suggestedPresetId?: string | null;
  reviewerPresetId?: string | null;
  scoutPresetId?: string | null;
  plannerPresetId?: string | null;
  origin?: CardOrigin;
  originRef?: string | null;
  dedupeKey?: string | null;
  planSessionId?: string | null;
  parentCardId?: string | null;
  tagIds?: string[];
  /** Default: end of the target column. */
  sortKey?: string;
  worktree?: string | null;
}

export interface UpdateCardInput {
  title?: string;
  description?: string;
  priority?: CardPriority;
  acceptance?: string;
  refImages?: string[];
  needsEvidence?: boolean;
  presetId?: string | null;
  suggestedPresetId?: string | null;
  reviewerPresetId?: string | null;
  scoutPresetId?: string | null;
  plannerPresetId?: string | null;
  /** Read positions of the card tabs (WP-105); see contract/card-tabs.ts markReadPatch. */
  planSeenAt?: string | null;
  execSeenAt?: string | null;
  verifySeenAt?: string | null;
  parentCardId?: string | null;
  planSessionId?: string | null;
  worktree?: string | null;
}

/** Card fields that only move a read position (no edit of the card). */
const READ_POSITION_FIELDS = new Set(["planSeenAt", "execSeenAt", "verifySeenAt"]);

/** WP-105: the planning model's result for a card (cards.setPlan). */
export interface SetPlanInput {
  /** The complete new plan; omitted = plan unchanged (only the criteria changed). */
  plan?: PlanSnapshot;
  /** New acceptance criteria; omitted or blank = unchanged. */
  acceptance?: string;
  /** Who wrote it (event author), e.g. "planner". */
  author?: string;
  /** Shown with an acceptance proposal when the owner had edited the criteria. */
  rationale?: string;
}

export interface SetPlanResult {
  card: CardView;
  planChanged: boolean;
  /** applied: written to the card; proposed: the owner edited it, so a proposal waits in the plan chat. */
  acceptance: "applied" | "proposed" | "unchanged" | "none";
}

export interface AddChatInput {
  /** Sync materialization: keep the id/creation time a replica generated offline. */
  id?: string;
  createdAt?: string;
  cardId: string;
  authorKind: AuthorKind;
  author?: string;
  text: string;
  sessionId?: string;
  agentId?: string;
  kind?: ChatKind;
  /** Idempotency key (unique per card): writing the same key again returns the first event. */
  key?: string;
  answers?: string[];
  fallback?: string[];
  detail?: string;
  planVersion?: number;
  ready?: boolean;
  error?: boolean;
  thread?: ChatThread;
  action?: "make_plan";
}

export interface ProposeInput {
  cardId: string;
  /** At least one of title / description / acceptance. */
  changes: ProposalChanges;
  rationale: string;
  /** Default: master. */
  authorKind?: AuthorKind;
  author?: string;
}

export interface MoveCardInput {
  to: CardColumn;
  actor: MoveActor;
  reason?: string;
  /** Default: end of the target column. */
  sortKey?: string;
}

export interface AddCardEventInput {
  /** Sync materialization: keep the id/creation time a replica generated offline. */
  id?: string;
  createdAt?: string;
  cardId: string;
  type: CardEventType;
  authorKind: AuthorKind;
  author?: string;
  body?: unknown;
}

export interface StartSessionInput {
  cardId: string | null;
  agentId: string;
  workspaceId?: string | null;
  role: SessionRole;
  provider: string;
  complexity?: SessionComplexity | null;
  reassignedFromSessionId?: string | null;
}

export interface RecordReassignInput {
  /** The failed/stalled session to end. */
  fromSessionId: string;
  /** Paseo agent id of the replacement. */
  agentId: string;
  workspaceId?: string | null;
  provider: string;
  /** Why: error | stalled | quota | ... */
  reason: string;
  /** Preset the replacement runs on; also written to card.preset_id when given. */
  presetId?: string | null;
}

export interface DispatchCardInput {
  cardId: string;
  agentId: string;
  workspaceId?: string | null;
  provider: string;
  worktree: string | null;
  presetId?: string | null;
}

export interface SetSessionStateOptions {
  /** state=waiting: what the agent asked. */
  question?: unknown;
  /** state=error. */
  message?: string;
  /** state=ended: completed | canceled | ... */
  outcome?: string;
}

export interface ListCardsFilter {
  projectId?: string;
  column?: CardColumn;
  tagId?: string;
  includeArchived?: boolean;
  parentCardId?: string;
}

// --- store ------------------------------------------------------------------------------------

type Enc = (value: never) => SqlParam;
const asJson: Enc = (v) => JSON.stringify(v);
const asBool: Enc = (v) => ((v as unknown as boolean) ? 1 : 0);
const asJsonOrNull: Enc = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
const asIs: Enc = (v) => v as unknown as SqlParam;

type FieldMap = Record<string, readonly [column: string, encode: Enc]>;

const PROJECT_FIELDS: FieldMap = {
  name: ["name", asIs],
  repoPath: ["repo_path", asIs],
  projectTypes: ["project_types_json", asJson],
  projectType: ["project_type", asIs],
  description: ["description", asIs],
  requirementsPath: ["requirements_path", asIs],
  defaultPresetId: ["default_preset_id", asIs],
  concurrencyLimit: ["concurrency_limit", asIs],
  devices: ["devices_json", asJson],
  paseoProjectId: ["paseo_project_id", asIs],
  color: ["color", asIs],
};
const PRESET_FIELDS: FieldMap = {
  name: ["name", asIs],
  provider: ["provider", asIs],
  model: ["model", asIs],
  thinking: ["thinking", asIs],
  permissionMode: ["permission_mode", asIs],
  environmentKind: ["environment_kind", asIs],
  baseBranch: ["base_branch", asIs],
  runtimeEnv: ["runtime_env", asIs],
  instructions: ["instructions", asIs],
  fallbackPresetIds: ["fallback_preset_ids_json", asJsonOrNull],
  roleHints: ["role_hints_json", asJson],
  roleHint: ["role_hint", asIs],
};
const CARD_FIELDS: FieldMap = {
  title: ["title", asIs],
  description: ["description", asIs],
  priority: ["priority", asIs],
  acceptance: ["acceptance", asIs],
  refImages: ["ref_images_json", asJson],
  needsEvidence: ["needs_evidence", asBool],
  presetId: ["preset_id", asIs],
  suggestedPresetId: ["suggested_preset_id", asIs],
  reviewerPresetId: ["reviewer_preset_id", asIs],
  scoutPresetId: ["scout_preset_id", asIs],
  plannerPresetId: ["planner_preset_id", asIs],
  planSeenAt: ["plan_seen_at", asIs],
  execSeenAt: ["exec_seen_at", asIs],
  verifySeenAt: ["verify_seen_at", asIs],
  parentCardId: ["parent_card_id", asIs],
  planSessionId: ["plan_session_id", asIs],
  worktree: ["worktree", asIs],
};

/** Collects optional WHERE conditions; a condition with an undefined parameter is skipped. */
class WhereBuilder {
  private readonly conditions: string[] = [];
  readonly params: SqlParam[] = [];
  add(condition: string, ...params: Array<SqlParam | undefined>): void {
    if (params.length > 0 && params[0] === undefined) return;
    this.conditions.push(condition);
    this.params.push(...(params as SqlParam[]));
  }
  clause(): string {
    return this.conditions.length ? `WHERE ${this.conditions.join(" AND ")}` : "";
  }
}

/**
 * projectTypes / projectType -> both columns, kept consistent (projectType = projectTypes[0]).
 * Returns the patch with both set, or unchanged when neither is present.
 */
function normalizeProjectInput<T extends { projectTypes?: ProjectType[]; projectType?: ProjectType }>(
  input: T,
): T {
  let types = input.projectTypes;
  if (types === undefined && input.projectType === undefined) return input;
  types = [...new Set(types ?? [input.projectType!])];
  if (types.length === 0) throw new CommandError("invalid", "projectTypes must not be empty");
  return { ...input, projectTypes: types, projectType: types[0] };
}

function checkRequirementsPath(path: string | undefined): void {
  if (path !== undefined && !isSafeRepoRelativePath(path))
    throw new CommandError(
      "invalid",
      `requirementsPath must be a path relative to the repository root (no absolute path, no ".."): ${path}`,
    );
}

/** roleHints / roleHint -> both columns, kept consistent (roleHint = roleHints[0] ?? null). */
function normalizePresetInput<T extends { roleHints?: RoleHint[]; roleHint?: string | null }>(
  input: T,
): T {
  if (input.roleHints === undefined && input.roleHint === undefined) return input;
  const known = (v: unknown): v is RoleHint => (ROLE_HINTS as readonly unknown[]).includes(v);
  const hints = [...new Set(input.roleHints ?? (known(input.roleHint) ? [input.roleHint] : []))];
  for (const h of hints)
    if (!known(h)) throw new CommandError("invalid", `Unknown role hint "${String(h)}"`);
  return { ...input, roleHints: hints, roleHint: hints[0] ?? null };
}

export type VibeStore = ReturnType<typeof createVibeStore>;

export function createVibeStore(db: VibeDb, options: StoreOptions = {}) {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  let cachedDeviceId = options.deviceId;

  // ---- internals ----

  function deviceId(): string {
    if (cachedDeviceId) return cachedDeviceId;
    db.prepare("INSERT OR IGNORE INTO vibe_meta (key, value) VALUES ('device_id', ?)").run(
      newId(now().getTime()),
    );
    cachedDeviceId = db
      .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = 'device_id'")
      .get()!.value;
    return cachedDeviceId;
  }

  /** Next HLC; persisted so it stays monotonic across processes (call inside a write txn). */
  function nextHlc(): Hlc {
    const prev = db
      .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = 'hlc'")
      .get()?.value;
    const hlc = tickHlc(prev, now().getTime(), deviceId());
    db.prepare(
      "INSERT INTO vibe_meta (key, value) VALUES ('hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(hlc);
    return hlc;
  }

  function stampFields(table: string, rowId: string, columns: readonly string[], hlc: Hlc): void {
    const spec = syncSpec(table);
    if (!spec || spec.direction !== "both") return;
    const stmt = db.prepare(
      `INSERT INTO sync_meta (table_name, row_id, column_name, hlc, device_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(table_name, row_id, column_name) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id`,
    );
    for (const column of columns)
      if (spec.fields.includes(column)) stmt.run(table, rowId, column, hlc, deviceId());
  }

  function tombstone(table: string, rowId: string, hlc: Hlc): void {
    db.prepare(
      `INSERT INTO sync_tombstone (table_name, row_id, hlc, device_id, deleted_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(table_name, row_id) DO UPDATE SET hlc = excluded.hlc, device_id = excluded.device_id,
         deleted_at = excluded.deleted_at`,
    ).run(table, rowId, hlc, deviceId(), iso());
    db.prepare("DELETE FROM sync_meta WHERE table_name = ? AND row_id = ?").run(table, rowId);
  }

  /** UPDATE the mapped fields of `patch` that are present; returns the changed column names. */
  function patchRow(
    table: string,
    id: string,
    fields: FieldMap,
    patch: Record<string, unknown>,
    hlc: Hlc,
    withUpdatedAt = true,
  ): { keys: string[]; columns: string[] } {
    const keys: string[] = [];
    const columns: string[] = [];
    const values: SqlParam[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const mapped = fields[key];
      if (!mapped) throw new CommandError("invalid", `Unknown field "${key}" for ${table}`);
      keys.push(key);
      columns.push(mapped[0]);
      values.push((mapped[1] as (v: unknown) => SqlParam)(value));
    }
    if (columns.length === 0) return { keys, columns };
    const sets = columns.map((c) => `"${c}" = ?`);
    sets.push("updated_hlc = ?");
    values.push(hlc);
    if (withUpdatedAt) {
      sets.push("updated_at = ?");
      values.push(iso());
    }
    db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    stampFields(table, id, columns, hlc);
    return { keys, columns };
  }

  function emit(
    type: Parameters<typeof publishEvent>[1]["type"],
    payload: unknown,
    refs: { cardId?: string | null; projectId?: string | null },
  ): void {
    publishEvent(
      db,
      { type, payload, cardId: refs.cardId ?? null, projectId: refs.projectId ?? null } as never,
      now,
    );
  }

  function insertCardEvent(input: AddCardEventInput, hlc: Hlc): CardEvent {
    const id = input.id ?? newId(now().getTime());
    db.prepare(
      `INSERT INTO card_event (id, card_id, type, author_kind, author, body_json, created_at, updated_hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.cardId,
      input.type,
      input.authorKind,
      input.author ?? "",
      JSON.stringify(input.body ?? {}),
      input.createdAt ?? iso(),
      hlc,
    );
    stampFields("card_event", id, syncSpec("card_event")!.fields, hlc);
    const created = decodeRow(
      CardEventSchema,
      db.prepare("SELECT * FROM card_event WHERE id = ?").get(id)!,
    );
    // Unread markers (WP-105): the tabs this event gives new content. Daemon-owned display
    // columns: no sync stamp, no card.updated.
    for (const tab of activityTabsOf(created)) {
      const column = ACTIVITY_COLUMN[tab];
      db.prepare(
        `UPDATE card SET ${column} = ? WHERE id = ? AND (${column} IS NULL OR ${column} < ?)`,
      ).run(created.createdAt, created.cardId, created.createdAt);
    }
    return created;
  }

  function rawCard(id: string): Row {
    const row = db.prepare("SELECT * FROM card WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Card not found: ${id}`);
    return row;
  }

  function viewOf(row: Row): CardView {
    const tags = db
      .prepare<{ tag_id: string }>("SELECT tag_id FROM card_tag WHERE card_id = ? ORDER BY tag_id")
      .all(row.id as string)
      .map((r) => r.tag_id);
    return { ...decodeRow(CardSchema, row), tags };
  }

  function lastSortKey(projectId: string, column: CardColumn): string | null {
    return (
      db
        .prepare<{ k: string | null }>(
          `SELECT MAX(sort_key) AS k FROM card WHERE project_id = ? AND "column" = ? AND archived_at IS NULL`,
        )
        .get(projectId, column)?.k ?? null
    );
  }

  function mustProject(id: string): Project {
    const row = db.prepare("SELECT * FROM project WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Project not found: ${id}`);
    return decodeRow(ProjectSchema, row);
  }

  function writeCardTags(cardId: string, tagIds: readonly string[], hlc: Hlc): boolean {
    const wanted = new Set(tagIds);
    const have = new Set(
      db
        .prepare<{ tag_id: string }>("SELECT tag_id FROM card_tag WHERE card_id = ?")
        .all(cardId)
        .map((r) => r.tag_id),
    );
    let changed = false;
    for (const tagId of wanted) {
      if (have.has(tagId)) continue;
      if (!db.prepare("SELECT 1 AS x FROM tag WHERE id = ?").get(tagId)) {
        throw new CommandError("not_found", `Tag not found: ${tagId}`);
      }
      db.prepare("INSERT INTO card_tag (card_id, tag_id, updated_hlc) VALUES (?, ?, ?)").run(
        cardId,
        tagId,
        hlc,
      );
      db.prepare("DELETE FROM sync_tombstone WHERE table_name = 'card_tag' AND row_id = ?").run(
        `${cardId}:${tagId}`,
      );
      changed = true;
    }
    for (const tagId of have) {
      if (wanted.has(tagId)) continue;
      db.prepare("DELETE FROM card_tag WHERE card_id = ? AND tag_id = ?").run(cardId, tagId);
      tombstone("card_tag", `${cardId}:${tagId}`, hlc);
      changed = true;
    }
    return changed;
  }

  const write = <T>(fn: (hlc: Hlc) => T): T =>
    db.immediate(() => {
      const hlc = nextHlc();
      return fn(hlc);
    });

  // ---- proposals (card events of type "proposal") ----

  function pendingProposals(cardId: string): Array<{ id: string; body: ProposalEventBody }> {
    const rows = db
      .prepare<{ id: string; body_json: string }>(
        "SELECT id, body_json FROM card_event WHERE card_id = ? AND type = 'proposal' ORDER BY created_at, id",
      )
      .all(cardId);
    return rows.flatMap((r) => {
      const parsed = ProposalEventBodySchema.safeParse(JSON.parse(r.body_json));
      return parsed.success && parsed.data.status === "pending"
        ? [{ id: r.id, body: parsed.data }]
        : [];
    });
  }

  function mustPendingProposal(eventId: string): { event: CardEvent; body: ProposalEventBody } {
    const row = db.prepare("SELECT * FROM card_event WHERE id = ?").get(eventId);
    if (!row) throw new CommandError("not_found", `Card event not found: ${eventId}`);
    const event = decodeRow(CardEventSchema, row);
    if (event.type !== "proposal")
      throw new CommandError("invalid", `Card event ${eventId} is not a proposal`);
    const body = ProposalEventBodySchema.parse(event.body);
    if (body.status !== "pending")
      throw new CommandError("conflict", `Proposal ${eventId} is already ${body.status}`);
    return { event, body };
  }

  function setProposalStatus(
    eventId: string,
    body: ProposalEventBody,
    status: ProposalEventBody["status"],
    hlc: Hlc,
    resolvedBy?: string,
  ): CardEvent {
    const next: ProposalEventBody = { ...body, status };
    if (resolvedBy !== undefined) {
      next.resolvedBy = resolvedBy;
      next.resolvedAt = iso();
    }
    db.prepare("UPDATE card_event SET body_json = ?, updated_hlc = ? WHERE id = ?").run(
      JSON.stringify(next),
      hlc,
      eventId,
    );
    stampFields("card_event", eventId, ["body_json"], hlc);
    return decodeRow(CardEventSchema, db.prepare("SELECT * FROM card_event WHERE id = ?").get(eventId)!);
  }

  // ---- projects ----

  const projects = {
    create(rawInput: CreateProjectInput): Project {
      const input = normalizeProjectInput(rawInput);
      checkRequirementsPath(input.requirementsPath);
      if (!PROJECT_PREFIX_PATTERN.test(input.prefix)) {
        throw new CommandError(
          "invalid",
          `Invalid project prefix "${input.prefix}" (A-Z0-9, starts with a letter, max 10)`,
        );
      }
      return write((hlc) => {
        const id = newId(now().getTime());
        try {
          db.prepare(
            `INSERT INTO project (id, name, prefix, repo_path, project_type, project_types_json, description,
               requirements_path, default_preset_id, concurrency_limit,
               devices_json, paseo_project_id, color, created_at, updated_at, updated_hlc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            input.name,
            input.prefix,
            input.repoPath,
            input.projectType ?? "other",
            JSON.stringify(input.projectTypes ?? ["other"]),
            input.description ?? "",
            input.requirementsPath ?? DEFAULT_REQUIREMENTS_PATH,
            input.defaultPresetId ?? null,
            input.concurrencyLimit ?? null,
            JSON.stringify(input.devices ?? []),
            input.paseoProjectId ?? null,
            input.color ?? null,
            iso(),
            iso(),
            hlc,
          );
        } catch (error) {
          if (String(error).includes("UNIQUE"))
            throw new CommandError("conflict", `Project prefix "${input.prefix}" already exists`);
          throw error;
        }
        stampFields(
          "project",
          id,
          Object.values(PROJECT_FIELDS).map((f) => f[0]),
          hlc,
        );
        return mustProject(id);
      });
    },
    update(id: string, rawPatch: UpdateProjectInput): Project {
      const patch = normalizeProjectInput(rawPatch);
      checkRequirementsPath(patch.requirementsPath);
      return write((hlc) => {
        mustProject(id);
        const { archived, ...rest } = patch;
        patchRow("project", id, PROJECT_FIELDS, rest, hlc);
        if (archived !== undefined) {
          db.prepare(
            "UPDATE project SET archived_at = ?, updated_at = ?, updated_hlc = ? WHERE id = ?",
          ).run(archived ? iso() : null, iso(), hlc, id);
          stampFields("project", id, ["archived_at"], hlc);
        }
        return mustProject(id);
      });
    },
    get: (id: string): Project | undefined => {
      const row = db.prepare("SELECT * FROM project WHERE id = ?").get(id);
      return row ? decodeRow(ProjectSchema, row) : undefined;
    },
    list(includeArchived = false): Project[] {
      return decodeRows(
        ProjectSchema,
        db
          .prepare(
            `SELECT * FROM project ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at, id`,
          )
          .all(),
      );
    },
  };

  // ---- presets & tags ----

  function mustPreset(id: string): Preset {
    const row = db.prepare("SELECT * FROM preset WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Preset not found: ${id}`);
    return decodeRow(PresetSchema, row);
  }

  const presets = {
    create(rawInput: CreatePresetInput): Preset {
      const input = normalizePresetInput(rawInput);
      return write((hlc) => {
        const id = input.id ?? newId(now().getTime());
        try {
          db.prepare(
            `INSERT INTO preset (id, name, provider, model, thinking, permission_mode, environment_kind, base_branch,
               runtime_env, instructions, fallback_preset_ids_json, role_hint, role_hints_json, builtin, created_at, updated_at, updated_hlc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            input.name,
            input.provider,
            input.model,
            input.thinking ?? "",
            input.permissionMode ?? "accept-edits",
            input.environmentKind ?? "project-default",
            input.baseBranch ?? null,
            input.runtimeEnv ?? null,
            input.instructions ?? "",
            input.fallbackPresetIds ? JSON.stringify(input.fallbackPresetIds) : null,
            input.roleHint ?? null,
            JSON.stringify(input.roleHints ?? []),
            input.builtin ? 1 : 0,
            iso(),
            iso(),
            hlc,
          );
        } catch (error) {
          if (String(error).includes("UNIQUE"))
            throw new CommandError("conflict", `Preset "${input.name}" already exists`);
          throw error;
        }
        stampFields(
          "preset",
          id,
          Object.values(PRESET_FIELDS).map((f) => f[0]),
          hlc,
        );
        return mustPreset(id);
      });
    },
    update(id: string, rawPatch: UpdatePresetInput): Preset {
      const patch = normalizePresetInput(rawPatch);
      return write((hlc) => {
        mustPreset(id);
        const { builtin: _ignored, ...rest } = patch;
        patchRow("preset", id, PRESET_FIELDS, rest, hlc);
        return mustPreset(id);
      });
    },
    delete(id: string): void {
      write((hlc) => {
        mustPreset(id);
        db.prepare("UPDATE project SET default_preset_id = NULL WHERE default_preset_id = ?").run(
          id,
        );
        db.prepare("UPDATE card SET preset_id = NULL WHERE preset_id = ?").run(id);
        db.prepare("UPDATE card SET suggested_preset_id = NULL WHERE suggested_preset_id = ?").run(
          id,
        );
        db.prepare("UPDATE card SET reviewer_preset_id = NULL WHERE reviewer_preset_id = ?").run(id);
        db.prepare("UPDATE card SET scout_preset_id = NULL WHERE scout_preset_id = ?").run(id);
        db.prepare("UPDATE card SET planner_preset_id = NULL WHERE planner_preset_id = ?").run(id);
        db.prepare("DELETE FROM preset WHERE id = ?").run(id);
        tombstone("preset", id, hlc);
        // Drop the deleted id from other presets' fallback chains.
        for (const other of presets.list()) {
          if (!other.fallbackPresetIds?.includes(id)) continue;
          const rest = other.fallbackPresetIds.filter((x) => x !== id);
          patchRow(
            "preset",
            other.id,
            PRESET_FIELDS,
            { fallbackPresetIds: rest.length ? rest : null },
            hlc,
          );
        }
      });
    },
    get: (id: string): Preset | undefined => {
      const row = db.prepare("SELECT * FROM preset WHERE id = ?").get(id);
      return row ? decodeRow(PresetSchema, row) : undefined;
    },
    list: (): Preset[] =>
      decodeRows(PresetSchema, db.prepare("SELECT * FROM preset ORDER BY name").all()),
  };

  const tags = {
    list: (): Tag[] =>
      decodeRows(TagSchema, db.prepare("SELECT * FROM tag ORDER BY builtin DESC, rowid").all()),
    create(name: string, evidence = false, tagId?: string, color = ""): Tag {
      return write((hlc) => {
        const id = tagId ?? newId(now().getTime());
        try {
          db.prepare(
            "INSERT INTO tag (id, name, evidence, color, builtin, updated_hlc) VALUES (?, ?, ?, ?, 0, ?)",
          ).run(id, name, evidence ? 1 : 0, color, hlc);
        } catch (error) {
          if (String(error).includes("UNIQUE"))
            throw new CommandError("conflict", `Tag "${name}" already exists`);
          throw error;
        }
        stampFields("tag", id, ["name", "evidence", "color"], hlc);
        return decodeRow(TagSchema, db.prepare("SELECT * FROM tag WHERE id = ?").get(id)!);
      });
    },
    /** Rename / recolor / toggle the evidence default. Cards keep the same tag id, so they follow. */
    update(id: string, patch: { name?: string; evidence?: boolean; color?: string }): Tag {
      return write((hlc) => {
        if (!db.prepare("SELECT 1 AS x FROM tag WHERE id = ?").get(id))
          throw new CommandError("not_found", `Tag not found: ${id}`);
        const name = patch.name?.trim();
        if (patch.name !== undefined && !name) throw new CommandError("invalid", "Tag name is empty");
        const sets: string[] = [];
        const params: (string | number)[] = [];
        const changed: string[] = [];
        if (name !== undefined) {
          sets.push("name = ?");
          params.push(name);
          changed.push("name");
        }
        if (patch.evidence !== undefined) {
          sets.push("evidence = ?");
          params.push(patch.evidence ? 1 : 0);
          changed.push("evidence");
        }
        if (patch.color !== undefined) {
          sets.push("color = ?");
          params.push(patch.color.trim());
          changed.push("color");
        }
        if (changed.length) {
          try {
            db.prepare(`UPDATE tag SET ${sets.join(", ")}, updated_hlc = ? WHERE id = ?`).run(
              ...params,
              hlc,
              id,
            );
          } catch (error) {
            if (String(error).includes("UNIQUE"))
              throw new CommandError("conflict", `Tag "${name}" already exists`);
            throw error;
          }
          stampFields("tag", id, changed, hlc);
        }
        return decodeRow(TagSchema, db.prepare("SELECT * FROM tag WHERE id = ?").get(id)!);
      });
    },
    /** Custom tags only; the default vocabulary is fixed. */
    delete(id: string): void {
      write((hlc) => {
        const row = db.prepare<{ builtin: number }>("SELECT builtin FROM tag WHERE id = ?").get(id);
        if (!row) throw new CommandError("not_found", `Tag not found: ${id}`);
        if (row.builtin) throw new CommandError("invalid", "Built-in tags cannot be deleted");
        for (const r of db
          .prepare<{ card_id: string }>("SELECT card_id FROM card_tag WHERE tag_id = ?")
          .all(id)) {
          tombstone("card_tag", `${r.card_id}:${id}`, hlc);
        }
        db.prepare("DELETE FROM tag WHERE id = ?").run(id);
        tombstone("tag", id, hlc);
      });
    },
  };

  // ---- cards ----

  const cards = {
    get(idOrKey: string): CardView | undefined {
      const row = CARD_KEY_PATTERN.test(idOrKey)
        ? db.prepare("SELECT * FROM card WHERE key = ?").get(idOrKey)
        : db.prepare("SELECT * FROM card WHERE id = ?").get(idOrKey);
      return row ? viewOf(row) : undefined;
    },

    list(filter: ListCardsFilter = {}): CardView[] {
      const w = new WhereBuilder();
      w.add("c.project_id = ?", filter.projectId);
      w.add('c."column" = ?', filter.column);
      w.add("c.parent_card_id = ?", filter.parentCardId);
      w.add(
        "EXISTS (SELECT 1 FROM card_tag t WHERE t.card_id = c.id AND t.tag_id = ?)",
        filter.tagId,
      );
      if (!filter.includeArchived) w.add("c.archived_at IS NULL");
      return db
        .prepare(`SELECT c.* FROM card c ${w.clause()} ORDER BY c.sort_key, c.id`)
        .all(...w.params)
        .map(viewOf);
    },

    create(input: CreateCardInput, actor: MoveActor = "user", author = ""): CardView {
      const column = input.column ?? "draft";
      const origin = input.origin ?? "manual";
      if (!input.title.trim()) throw new CommandError("invalid", "Card title is required");
      if (!canCreateIn(column, origin, actor)) {
        throw new StateMachineError(
          "illegal_create",
          `"${actor}" may not create a ${origin} card in "${column}"`,
        );
      }
      return write((hlc) => {
        const project = mustProject(input.projectId);
        const id = input.id ?? newId(now().getTime());
        const createdAt = input.createdAt ?? iso();
        const number = project.nextNumber;
        const key = `${project.prefix}-${number}`;
        const tagIds = input.tagIds ?? [];
        let needsEvidence = input.needsEvidence;
        if (needsEvidence === undefined) {
          needsEvidence = tagIds.some(
            (t) =>
              db.prepare<{ evidence: number }>("SELECT evidence FROM tag WHERE id = ?").get(t)
                ?.evidence === 1,
          );
        }
        db.prepare("UPDATE project SET next_number = next_number + 1 WHERE id = ?").run(project.id);
        db.prepare(
          `INSERT INTO card (id, project_id, number, key, title, description, "column", sort_key, priority, acceptance,
             ref_images_json, needs_evidence, preset_id, suggested_preset_id, reviewer_preset_id, scout_preset_id, planner_preset_id,
             worktree, origin, origin_ref, dedupe_key, plan_session_id, parent_card_id, created_at, updated_at, updated_hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          project.id,
          number,
          key,
          input.title.trim(),
          input.description ?? "",
          column,
          input.sortKey ?? sortKeyAfter(lastSortKey(project.id, column)),
          input.priority ?? "none",
          input.acceptance ?? "",
          JSON.stringify(input.refImages ?? []),
          needsEvidence ? 1 : 0,
          input.presetId ?? null,
          input.suggestedPresetId ?? null,
          input.reviewerPresetId ?? null,
          input.scoutPresetId ?? null,
          input.plannerPresetId ?? null,
          input.worktree ?? null,
          origin,
          input.originRef ?? null,
          input.dedupeKey ?? null,
          input.planSessionId ?? null,
          input.parentCardId ?? null,
          createdAt,
          createdAt,
          hlc,
        );
        stampFields("card", id, syncSpec("card")!.fields, hlc);
        writeCardTags(id, tagIds, hlc);
        insertCardEvent(
          {
            cardId: id,
            type: "status",
            authorKind: actor === "user" || actor === "phone" ? "user" : "system",
            author,
            body: { kind: "created", column, origin },
          },
          hlc,
        );
        emit(
          "card.created",
          { key, title: input.title.trim(), column, origin },
          { cardId: id, projectId: project.id },
        );
        return viewOf(rawCard(id));
      });
    },

    update(id: string, patch: UpdateCardInput): CardView {
      return write((hlc) => {
        const before = rawCard(id);
        if (patch.title !== undefined && !patch.title.trim())
          throw new CommandError("invalid", "Card title is required");
        // Marking a tab read is not an edit of the card: no updated_at bump, no card.updated.
        const readOnly = Object.entries(patch).every(
          ([k, v]) => v === undefined || READ_POSITION_FIELDS.has(k),
        );
        const { keys } = patchRow(
          "card",
          id,
          CARD_FIELDS,
          patch as Record<string, unknown>,
          hlc,
          !readOnly,
        );
        if (keys.length > 0 && !readOnly)
          emit(
            "card.updated",
            { fields: keys },
            { cardId: id, projectId: before.project_id as string },
          );
        return viewOf(rawCard(id));
      });
    },

    /** Group-chat message on a card (card event type "chat"). */
    addChat(input: AddChatInput): CardEvent {
      if (!input.text.trim()) throw new CommandError("invalid", "Chat text is required");
      if (input.key !== undefined) {
        const row = db
          .prepare(
            "SELECT * FROM card_event WHERE card_id = ? AND type = 'chat' AND json_extract(body_json, '$.key') = ? ORDER BY created_at, id LIMIT 1",
          )
          .get(input.cardId, input.key);
        if (row) return decodeRow(CardEventSchema, row);
      }
      const body: ChatEventBody = { text: input.text };
      if (input.sessionId !== undefined) body.sessionId = input.sessionId;
      if (input.agentId !== undefined) body.agentId = input.agentId;
      if (input.kind !== undefined) body.kind = input.kind;
      if (input.key !== undefined) body.key = input.key;
      if (input.answers !== undefined) body.answers = input.answers;
      if (input.fallback !== undefined) body.fallback = input.fallback;
      if (input.detail !== undefined) body.detail = input.detail;
      if (input.planVersion !== undefined) body.planVersion = input.planVersion;
      if (input.ready !== undefined) body.ready = input.ready;
      if (input.error !== undefined) body.error = input.error;
      if (input.thread !== undefined) body.thread = input.thread;
      if (input.action !== undefined) body.action = input.action;
      return events.add({
        id: input.id,
        createdAt: input.createdAt,
        cardId: input.cardId,
        type: "chat",
        authorKind: input.authorKind,
        author: input.author,
        body,
      });
    },

    /**
     * The master suggests new title / description / acceptance. A proposal is a "proposal" card
     * event whose body.status moves pending -> accepted | rejected | superseded (body_json is a
     * field-level LWW sync field, so status changes sync like any edit). A new proposal supersedes
     * the card's earlier pending ones.
     */
    propose(input: ProposeInput): CardEvent {
      const changes = ProposalChangesSchema.parse(input.changes);
      if (Object.values(changes).every((v) => v === undefined))
        throw new CommandError("invalid", "A proposal needs at least one change");
      return write((hlc) => {
        const row = rawCard(input.cardId);
        for (const p of pendingProposals(input.cardId)) setProposalStatus(p.id, p.body, "superseded", hlc);
        const before: ProposalChanges = {};
        for (const key of ["title", "description", "acceptance"] as const) {
          if (changes[key] !== undefined) before[key] = row[key] as string;
        }
        const body: ProposalEventBody = { changes, rationale: input.rationale, status: "pending", before };
        return insertCardEvent(
          {
            cardId: input.cardId,
            type: "proposal",
            authorKind: input.authorKind ?? "master",
            author: input.author,
            body,
          },
          hlc,
        );
      });
    },

    /** Apply a pending proposal's changes to the card (one card.updated event) and mark it accepted. */
    acceptProposal(eventId: string, actor: MoveActor): CardEvent {
      return write((hlc) => {
        const { event, body } = mustPendingProposal(eventId);
        const changes: UpdateCardInput = {};
        if (body.changes.title !== undefined) changes.title = body.changes.title;
        if (body.changes.description !== undefined) changes.description = body.changes.description;
        if (body.changes.acceptance !== undefined) changes.acceptance = body.changes.acceptance;
        cards.update(event.cardId, changes);
        // The criteria are the model's text again: its next revision may overwrite them.
        if (changes.acceptance !== undefined)
          db.prepare("UPDATE card SET model_acceptance = ? WHERE id = ?").run(
            changes.acceptance,
            event.cardId,
          );
        return setProposalStatus(eventId, body, "accepted", hlc, actor);
      });
    },

    rejectProposal(eventId: string, actor: MoveActor): CardEvent {
      return write((hlc) => {
        const { body } = mustPendingProposal(eventId);
        return setProposalStatus(eventId, body, "rejected", hlc, actor);
      });
    },

    /**
     * WP-105: store the planning model's plan as the card's only plan (overwrite) and its acceptance
     * criteria. Criteria the owner edited since the model last wrote them are never overwritten: the
     * new text becomes a pending proposal in the plan chat instead.
     */
    setPlan(id: string, input: SetPlanInput): SetPlanResult {
      const plan = input.plan === undefined ? undefined : PlanSnapshotSchema.parse(input.plan);
      return write((hlc) => {
        const before = rawCard(id);
        const projectId = before.project_id as string;
        const json = plan === undefined ? null : JSON.stringify(plan);
        const planChanged = json !== null && json !== before.plan_json;
        if (planChanged) {
          db.prepare(
            "UPDATE card SET plan_json = ?, updated_at = ?, updated_hlc = ? WHERE id = ?",
          ).run(json, iso(), hlc, id);
          insertCardEvent(
            {
              cardId: id,
              type: "note",
              authorKind: "agent",
              author: input.author ?? "planner",
              body: { kind: "plan_updated", text: "方案已更新" },
            },
            hlc,
          );
          emit("card.updated", { fields: ["plan"] }, { cardId: id, projectId });
        }
        let acceptance: SetPlanResult["acceptance"] = "none";
        const next = input.acceptance?.trim();
        if (next) {
          const current = before.acceptance as string;
          const model = before.model_acceptance as string;
          if (next === current.trim()) {
            acceptance = "unchanged";
            db.prepare("UPDATE card SET model_acceptance = ? WHERE id = ?").run(current, id);
          } else if (!current.trim() || current === model) {
            cards.update(id, { acceptance: next });
            db.prepare("UPDATE card SET model_acceptance = ? WHERE id = ?").run(next, id);
            acceptance = "applied";
          } else {
            if (!pendingProposals(id).some((pp) => pp.body.changes.acceptance?.trim() === next)) {
              cards.propose({
                cardId: id,
                changes: { acceptance: next },
                rationale: input.rationale ?? "你改过验收标准，所以这次的修改先作为建议提出，由你决定是否采纳。",
                authorKind: "master",
                author: input.author ?? "planner",
              });
            }
            acceptance = "proposed";
          }
        }
        return { card: viewOf(rawCard(id)), planChanged, acceptance };
      });
    },

    /** Pick (or clear with null) the preset that reviews the result of this card. */
    setReviewer(id: string, presetId: string | null): CardView {
      return write((hlc) => {
        const before = rawCard(id);
        if (presetId !== null) mustPreset(presetId);
        if (before.reviewer_preset_id !== presetId) {
          patchRow("card", id, CARD_FIELDS, { reviewerPresetId: presetId }, hlc);
          emit(
            "card.updated",
            { fields: ["reviewerPresetId"] },
            { cardId: id, projectId: before.project_id as string },
          );
        }
        return viewOf(rawCard(id));
      });
    },

    setTags(id: string, tagIds: readonly string[]): CardView {
      return write((hlc) => {
        const before = rawCard(id);
        if (writeCardTags(id, tagIds, hlc)) {
          db.prepare("UPDATE card SET updated_at = ? WHERE id = ?").run(iso(), id);
          emit(
            "card.updated",
            { fields: ["tags"] },
            { cardId: id, projectId: before.project_id as string },
          );
        }
        return viewOf(rawCard(id));
      });
    },

    /** Change order inside a column (fractional key). Not a state transition. */
    reorder(id: string, sortKey: string): CardView {
      return write((hlc) => {
        const before = rawCard(id);
        patchRowSort(id, sortKey, hlc);
        emit(
          "card.updated",
          { fields: ["sortKey"] },
          { cardId: id, projectId: before.project_id as string },
        );
        return viewOf(rawCard(id));
      });
    },

    /** Move between columns. The state machine decides who may do what; see contract/state-machine.ts. */
    move(id: string, input: MoveCardInput): CardView {
      return write((hlc) => {
        const before = rawCard(id);
        const from = before.column as CardColumn;
        assertTransition(from, input.to, input.actor);
        if (from === "todo" && input.to === "in_progress") {
          const live = db
            .prepare(
              "SELECT 1 AS x FROM agent_session WHERE card_id = ? AND role = 'worker' AND state NOT IN ('ended','error')",
            )
            .get(id);
          if (!live)
            throw new CommandError(
              "invalid",
              "A card can only enter in_progress through dispatch (needs a live worker session)",
            );
        }
        applyMove(before, input, hlc);
        return viewOf(rawCard(id));
      });
    },

    archive(id: string, archived = true): CardView {
      return write((hlc) => {
        const before = rawCard(id);
        db.prepare(
          "UPDATE card SET archived_at = ?, updated_at = ?, updated_hlc = ? WHERE id = ?",
        ).run(archived ? iso() : null, iso(), hlc, id);
        stampFields("card", id, ["archived_at"], hlc);
        emit(
          "card.updated",
          { fields: ["archivedAt"] },
          { cardId: id, projectId: before.project_id as string },
        );
        return viewOf(rawCard(id));
      });
    },

    /** Hard delete; only drafts that never ran. Leaves a tombstone for sync. */
    delete(id: string): void {
      write((hlc) => {
        const before = rawCard(id);
        if (before.column !== "draft")
          throw new CommandError("invalid", "Only draft cards can be deleted; archive others");
        if (db.prepare("SELECT 1 AS x FROM agent_session WHERE card_id = ?").get(id)) {
          throw new CommandError("invalid", "Card has sessions; archive it instead");
        }
        for (const r of db
          .prepare<{ id: string }>("SELECT id FROM card_event WHERE card_id = ?")
          .all(id))
          tombstone("card_event", r.id, hlc);
        for (const r of db
          .prepare<{ tag_id: string }>("SELECT tag_id FROM card_tag WHERE card_id = ?")
          .all(id)) {
          tombstone("card_tag", `${id}:${r.tag_id}`, hlc);
        }
        db.prepare("UPDATE card SET parent_card_id = NULL WHERE parent_card_id = ?").run(id);
        db.prepare("DELETE FROM card WHERE id = ?").run(id);
        tombstone("card", id, hlc);
        emit(
          "card.deleted",
          { key: before.key },
          { cardId: id, projectId: before.project_id as string },
        );
      });
    },

    /**
     * todo -> in_progress as one atomic step: creates the worker session, records worktree and
     * session start, and moves the card as "dispatcher".
     */
    dispatch(input: DispatchCardInput): { card: CardView; session: AgentSession } {
      return write((hlc) => {
        const before = rawCard(input.cardId);
        assertTransition(before.column as CardColumn, "in_progress", "dispatcher");
        const session = insertSession(
          {
            cardId: input.cardId,
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            role: "worker",
            provider: input.provider,
          },
          hlc,
        );
        db.prepare(
          "UPDATE card SET worktree = ?, preset_id = COALESCE(?, preset_id), updated_hlc = ? WHERE id = ?",
        ).run(input.worktree, input.presetId ?? null, hlc, input.cardId);
        applyMove(before, { to: "in_progress", actor: "dispatcher" }, hlc);
        emit(
          "card.dispatched",
          {
            sessionId: session.id,
            agentId: input.agentId,
            worktree: input.worktree,
            presetId: input.presetId ?? null,
          },
          { cardId: input.cardId, projectId: before.project_id as string },
        );
        return { card: viewOf(rawCard(input.cardId)), session };
      });
    },
  };

  function patchRowSort(id: string, sortKey: string, hlc: Hlc): void {
    db.prepare("UPDATE card SET sort_key = ?, updated_at = ?, updated_hlc = ? WHERE id = ?").run(
      sortKey,
      iso(),
      hlc,
      id,
    );
    stampFields("card", id, ["sort_key"], hlc);
  }

  function applyMove(before: Row, input: MoveCardInput, hlc: Hlc): void {
    const id = before.id as string;
    const projectId = before.project_id as string;
    const from = before.column as CardColumn;
    db.prepare(
      `UPDATE card SET "column" = ?, sort_key = ?, updated_at = ?, updated_hlc = ? WHERE id = ?`,
    ).run(
      input.to,
      input.sortKey ?? sortKeyAfter(lastSortKey(projectId, input.to)),
      iso(),
      hlc,
      id,
    );
    stampFields("card", id, ["column", "sort_key"], hlc);
    insertCardEvent(
      {
        cardId: id,
        type: "status",
        authorKind: input.actor === "user" || input.actor === "phone" ? "user" : "system",
        author: input.actor,
        body: { kind: "moved", from, to: input.to, actor: input.actor, reason: input.reason },
      },
      hlc,
    );
    emit(
      "card.moved",
      { from, to: input.to, actor: input.actor, reason: input.reason },
      { cardId: id, projectId },
    );
  }

  // ---- card events & plan versions ----

  const events = {
    add(input: AddCardEventInput): CardEvent {
      return write((hlc) => {
        const card = rawCard(input.cardId);
        const created = insertCardEvent(input, hlc);
        if (input.type === "evaluation") {
          emit(
            "card.assessed",
            { cardEventId: created.id },
            { cardId: input.cardId, projectId: card.project_id as string },
          );
        }
        return created;
      });
    },
    list: (cardId: string): CardEvent[] =>
      decodeRows(
        CardEventSchema,
        db
          .prepare("SELECT * FROM card_event WHERE card_id = ? ORDER BY created_at, id")
          .all(cardId),
      ),
  };

  const plans = {
    /** Append the next plan version (1, 2, ...) for a card. */
    save(cardId: string, snapshot: PlanSnapshot): PlanVersion {
      const parsed = PlanSnapshotSchema.parse(snapshot);
      return write(() => {
        const card = rawCard(cardId);
        const next =
          (db
            .prepare<{ v: number | null }>(
              "SELECT MAX(version) AS v FROM plan_version WHERE card_id = ?",
            )
            .get(cardId)?.v ?? 0) + 1;
        const id = newId(now().getTime());
        db.prepare(
          "INSERT INTO plan_version (id, card_id, version, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(id, cardId, next, JSON.stringify(parsed), iso());
        emit("plan.updated", { version: next }, { cardId, projectId: card.project_id as string });
        return decodeRow(
          PlanVersionSchema,
          db.prepare("SELECT * FROM plan_version WHERE id = ?").get(id)!,
        );
      });
    },
    list: (cardId: string): PlanVersion[] =>
      decodeRows(
        PlanVersionSchema,
        db.prepare("SELECT * FROM plan_version WHERE card_id = ? ORDER BY version").all(cardId),
      ),
  };

  // ---- agent sessions ----

  function mustSession(id: string): AgentSession {
    const row = db.prepare("SELECT * FROM agent_session WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Session not found: ${id}`);
    return decodeRow(AgentSessionSchema, row);
  }

  function projectOfCard(cardId: string | null): string | null {
    if (!cardId) return null;
    return (
      db.prepare<{ project_id: string }>("SELECT project_id FROM card WHERE id = ?").get(cardId)
        ?.project_id ?? null
    );
  }

  function insertSession(input: StartSessionInput, hlc: Hlc): AgentSession {
    if (input.cardId) rawCard(input.cardId);
    const id = newId(now().getTime());
    try {
      db.prepare(
        `INSERT INTO agent_session (id, card_id, agent_id, workspace_id, role, current_provider, state,
           last_activity_at, started_at, complexity, reassigned_from_session_id, updated_hlc)
         VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.cardId,
        input.agentId,
        input.workspaceId ?? null,
        input.role,
        input.provider,
        iso(),
        iso(),
        input.complexity ?? null,
        input.reassignedFromSessionId ?? null,
        hlc,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new CommandError("conflict", `Agent already has a session: ${input.agentId}`);
      throw error;
    }
    if (input.cardId) {
      insertCardEvent(
        {
          cardId: input.cardId,
          type: "status",
          authorKind: "system",
          author: input.role,
          body: {
            kind: "session_started",
            sessionId: id,
            role: input.role,
            provider: input.provider,
          },
        },
        hlc,
      );
    }
    emit(
      "session.started",
      { sessionId: id, agentId: input.agentId, role: input.role, provider: input.provider },
      { cardId: input.cardId, projectId: projectOfCard(input.cardId) },
    );
    return mustSession(id);
  }

  /** session.* bus events and the card timeline entry for a state change. */
  function announceSessionState(
    s: AgentSession,
    to: SessionState,
    opts: SetSessionStateOptions,
    hlc: Hlc,
  ): void {
    const refs = { cardId: s.cardId, projectId: projectOfCard(s.cardId) };
    const base = { sessionId: s.id, agentId: s.agentId };
    if (to === "waiting") emit("session.waiting", { ...base, question: opts.question }, refs);
    else if (to === "working" && s.state === "waiting") emit("session.answered", base, refs);
    else if (to === "ended") emit("session.ended", { ...base, outcome: opts.outcome }, refs);
    else if (to === "error") {
      emit("session.error", { ...base, message: opts.message ?? "unknown error" }, refs);
    }
    if (s.cardId && (to === "waiting" || to === "ended" || to === "error")) {
      insertCardEvent(
        {
          cardId: s.cardId,
          type: "status",
          authorKind: "system",
          author: s.role,
          body: {
            kind: `session_${to}`,
            sessionId: s.id,
            outcome: opts.outcome,
            message: opts.message,
          },
        },
        hlc,
      );
    }
  }

  function announceUnstalled(s: AgentSession, hlc: Hlc): void {
    emit(
      "session.unstalled",
      { sessionId: s.id, agentId: s.agentId },
      { cardId: s.cardId, projectId: projectOfCard(s.cardId) },
    );
    if (s.cardId) {
      insertCardEvent(
        {
          cardId: s.cardId,
          type: "status",
          authorKind: "system",
          author: s.role,
          body: { kind: "session_unstalled", sessionId: s.id },
        },
        hlc,
      );
    }
  }

  const sessions = {
    start: (input: StartSessionInput): AgentSession => write((hlc) => insertSession(input, hlc)),

    get: (id: string): AgentSession | undefined => {
      const row = db.prepare("SELECT * FROM agent_session WHERE id = ?").get(id);
      return row ? decodeRow(AgentSessionSchema, row) : undefined;
    },
    getByAgent: (agentId: string): AgentSession | undefined => {
      const row = db.prepare("SELECT * FROM agent_session WHERE agent_id = ?").get(agentId);
      return row ? decodeRow(AgentSessionSchema, row) : undefined;
    },
    list(
      filter: { cardId?: string; states?: readonly SessionState[]; role?: SessionRole } = {},
    ): AgentSession[] {
      const w = new WhereBuilder();
      w.add("card_id = ?", filter.cardId);
      w.add("role = ?", filter.role);
      if (filter.states?.length) {
        w.add(`state IN (${filter.states.map(() => "?").join(",")})`, ...filter.states);
      }
      return decodeRows(
        AgentSessionSchema,
        db
          .prepare(`SELECT * FROM agent_session ${w.clause()} ORDER BY started_at, id`)
          .all(...w.params),
      );
    },

    /** Validated state change; maintains waiting_since/pending_question and emits session.* events. */
    setState(id: string, to: SessionState, opts: SetSessionStateOptions = {}): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        assertSessionTransition(s.state, to);
        const t = iso();
        const sets: string[] = ["state = ?", "last_activity_at = ?", "updated_hlc = ?"];
        const params: SqlParam[] = [to, t, hlc];
        if (to === "waiting") {
          sets.push("waiting_since = ?", "pending_question_json = ?");
          params.push(
            s.state === "waiting" ? (s.waitingSince ?? t) : t,
            JSON.stringify(opts.question ?? s.pendingQuestion ?? null),
          );
        } else {
          sets.push("waiting_since = NULL", "pending_question_json = NULL");
        }
        if (to === "ended" || to === "error") sets.push("stalled_since = NULL");
        if (to === "ended") {
          sets.push("ended_at = ?");
          params.push(t);
        }
        if (to === "error") {
          sets.push("error_message = ?");
          params.push(opts.message ?? "unknown error");
        }
        if (to === "working" && s.state === "error") sets.push("error_message = NULL");
        db.prepare(`UPDATE agent_session SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);

        if (s.state !== to) announceSessionState(s, to, opts, hlc);
        return mustSession(id);
      });
    },

    /** Update cache expiry / activity without a state change (compaction scheduling). */
    touch(
      id: string,
      patch: { cacheExpiresAt?: string | null; lastActivityAt?: string },
    ): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        db.prepare(
          "UPDATE agent_session SET cache_expires_at = ?, last_activity_at = ?, updated_hlc = ? WHERE id = ?",
        ).run(
          patch.cacheExpiresAt === undefined ? s.cacheExpiresAt : patch.cacheExpiresAt,
          patch.lastActivityAt ?? iso(),
          hlc,
          id,
        );
        return mustSession(id);
      });
    },

    /**
     * Record output from the agent: bumps last_activity_at and, if the session was marked
     * stalled, clears the mark (session.unstalled). No state change.
     */
    touchActivity(id: string, at?: string): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        db.prepare(
          "UPDATE agent_session SET last_activity_at = ?, stalled_since = NULL, updated_hlc = ? WHERE id = ?",
        ).run(at ?? iso(), hlc, id);
        if (s.stalledSince) announceUnstalled(s, hlc);
        return mustSession(id);
      });
    },

    /**
     * Stall detector: mark a starting/working session as stalled (idempotent; the first
     * `since` wins). Not a session state - see agent_session.stalled_since.
     */
    markStalled(id: string, opts: { since?: string; idleMs?: number } = {}): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        if (s.stalledSince) return s;
        if (s.state !== "starting" && s.state !== "working")
          throw new CommandError("invalid", `Session in state "${s.state}" cannot be stalled`);
        const since = opts.since ?? iso();
        db.prepare("UPDATE agent_session SET stalled_since = ?, updated_hlc = ? WHERE id = ?").run(
          since,
          hlc,
          id,
        );
        emit(
          "session.stalled",
          { sessionId: id, agentId: s.agentId, stalledSince: since, idleMs: opts.idleMs },
          { cardId: s.cardId, projectId: projectOfCard(s.cardId) },
        );
        if (s.cardId) {
          insertCardEvent(
            {
              cardId: s.cardId,
              type: "status",
              authorKind: "system",
              author: s.role,
              body: { kind: "session_stalled", sessionId: id, since },
            },
            hlc,
          );
        }
        return mustSession(id);
      });
    },

    /** Clear the stalled mark without touching last_activity_at (no-op if not stalled). */
    clearStalled(id: string): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        if (!s.stalledSince) return s;
        db.prepare(
          "UPDATE agent_session SET stalled_since = NULL, updated_hlc = ? WHERE id = ?",
        ).run(hlc, id);
        announceUnstalled(s, hlc);
        return mustSession(id);
      });
    },

    /** Set (or clear with null) the task complexity; emits session.complexity_changed on change. */
    setComplexity(id: string, complexity: SessionComplexity | null): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        if (s.complexity === complexity) return s;
        db.prepare("UPDATE agent_session SET complexity = ?, updated_hlc = ? WHERE id = ?").run(
          complexity,
          hlc,
          id,
        );
        emit(
          "session.complexity_changed",
          { sessionId: id, agentId: s.agentId, from: s.complexity, to: complexity },
          { cardId: s.cardId, projectId: projectOfCard(s.cardId) },
        );
        return mustSession(id);
      });
    },

    /**
     * Failure reassignment in ONE transaction: end the old session (outcome "reassigned"),
     * start its replacement (same card/role/complexity, reassigned_from_session_id set),
     * optionally switch card.preset_id, write a switch_agent card event, emit session.reassigned.
     */
    recordReassign(input: RecordReassignInput): { from: AgentSession; to: AgentSession } {
      return write((hlc) => {
        const old = mustSession(input.fromSessionId);
        if (old.state === "ended")
          throw new CommandError("invalid", `Session already ended: ${old.id}`);
        assertSessionTransition(old.state, "ended");
        const t = iso();
        db.prepare(
          `UPDATE agent_session SET state = 'ended', ended_at = ?, last_activity_at = ?, stalled_since = NULL,
             waiting_since = NULL, pending_question_json = NULL, updated_hlc = ? WHERE id = ?`,
        ).run(t, t, hlc, old.id);
        const ended = mustSession(old.id);
        announceSessionState(old, "ended", { outcome: "reassigned" }, hlc);
        const next = insertSession(
          {
            cardId: old.cardId,
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            role: old.role,
            provider: input.provider,
            complexity: old.complexity,
            reassignedFromSessionId: old.id,
          },
          hlc,
        );
        if (old.cardId && input.presetId) {
          patchRow("card", old.cardId, CARD_FIELDS, { presetId: input.presetId }, hlc);
        }
        if (old.cardId) {
          insertCardEvent(
            {
              cardId: old.cardId,
              type: "switch_agent",
              authorKind: "system",
              author: old.role,
              body: {
                kind: "reassigned",
                fromSessionId: old.id,
                toSessionId: next.id,
                from: old.currentProvider,
                to: input.provider,
                presetId: input.presetId ?? null,
                reason: input.reason,
              },
            },
            hlc,
          );
        }
        emit(
          "session.reassigned",
          {
            sessionId: next.id,
            agentId: next.agentId,
            fromSessionId: old.id,
            fromAgentId: old.agentId,
            fromProvider: old.currentProvider,
            provider: input.provider,
            presetId: input.presetId ?? null,
            reason: input.reason,
          },
          { cardId: old.cardId, projectId: projectOfCard(old.cardId) },
        );
        return { from: ended, to: next };
      });
    },

    /** Subscription / provider switch inside a session; recorded in history and as a card event. */
    switchProvider(id: string, to: string, reason?: string): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        if (s.currentProvider === to) return s;
        const history = [...s.switchHistory, { from: s.currentProvider, to, at: iso(), reason }];
        db.prepare(
          "UPDATE agent_session SET current_provider = ?, switch_history_json = ?, updated_hlc = ? WHERE id = ?",
        ).run(to, JSON.stringify(history), hlc, id);
        if (s.cardId) {
          insertCardEvent(
            {
              cardId: s.cardId,
              type: "switch_agent",
              authorKind: "system",
              author: s.role,
              body: { sessionId: id, from: s.currentProvider, to, reason },
            },
            hlc,
          );
        }
        emit(
          "session.switched",
          { sessionId: id, agentId: s.agentId, from: s.currentProvider, to },
          { cardId: s.cardId, projectId: projectOfCard(s.cardId) },
        );
        return mustSession(id);
      });
    },

    recordCompaction(id: string, strategy = "compact"): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        if (s.cardId) {
          insertCardEvent(
            {
              cardId: s.cardId,
              type: "compaction",
              authorKind: "system",
              author: s.role,
              body: { sessionId: id, strategy },
            },
            hlc,
          );
        }
        db.prepare("UPDATE agent_session SET updated_hlc = ? WHERE id = ?").run(hlc, id);
        emit(
          "session.compacted",
          { sessionId: id, agentId: s.agentId, strategy },
          { cardId: s.cardId, projectId: projectOfCard(s.cardId) },
        );
        return mustSession(id);
      });
    },
  };

  // ---- git snapshot ----

  const gitSnapshots = {
    upsert(snapshot: Omit<GitSnapshot, "takenAt"> & { takenAt?: string }): GitSnapshot {
      return write(() => {
        mustProject(snapshot.projectId);
        db.prepare(
          `INSERT INTO git_snapshot (project_id, branch, ahead, behind, dirty_files, diff_stat, taken_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET branch = excluded.branch, ahead = excluded.ahead,
             behind = excluded.behind, dirty_files = excluded.dirty_files, diff_stat = excluded.diff_stat,
             taken_at = excluded.taken_at`,
        ).run(
          snapshot.projectId,
          snapshot.branch,
          snapshot.ahead,
          snapshot.behind,
          snapshot.dirtyFiles,
          snapshot.diffStat,
          snapshot.takenAt ?? iso(),
        );
        return decodeRow(
          GitSnapshotSchema,
          db.prepare("SELECT * FROM git_snapshot WHERE project_id = ?").get(snapshot.projectId)!,
        );
      });
    },
    get: (projectId: string): GitSnapshot | undefined => {
      const row = db.prepare("SELECT * FROM git_snapshot WHERE project_id = ?").get(projectId);
      return row ? decodeRow(GitSnapshotSchema, row) : undefined;
    },
  };

  // ---- prompt registry (WP-98) ----

  interface TemplateRow {
    key: string;
    plugin: string;
    role: string;
    title: string;
    description: string;
    when_sent: string;
    audience: string;
    default_text: string;
    placeholders_json: string;
    fixed_suffix: string;
    sort_order: number;
  }

  const mustTemplate = (key: string): TemplateRow => {
    const row = db.prepare<TemplateRow>("SELECT * FROM prompt_template WHERE key = ?").get(key);
    if (!row) throw new CommandError("not_found", `Prompt not registered: ${key}`);
    return row;
  };

  const overrideText = (key: string, projectId: string | null): string | null => {
    const row = db
      .prepare<{ text: string }>(
        "SELECT text FROM prompt_override WHERE key = ? AND COALESCE(project_id, '') = ?",
      )
      .get(key, projectId ?? "");
    return row && row.text.trim() ? row.text : null;
  };

  const prompts = {
    /**
     * Upsert defaults and metadata of the calling plugin's prompts. Overrides are never touched.
     * `pruneMissing` drops templates of the same plugin that are no longer in `defs` (renamed or
     * removed keys); their overrides stay in the table, harmless.
     */
    register(defs: readonly PromptDef[], options: { pruneMissing?: boolean } = {}): void {
      const parsed = defs.map((d) => PromptDefSchema.parse(d));
      write(() => {
        for (const d of parsed) {
          const have = db.prepare<TemplateRow>("SELECT * FROM prompt_template WHERE key = ?").get(d.key);
          const next = [
            d.plugin,
            d.role,
            d.title,
            d.description,
            d.whenSent,
            d.audience,
            d.defaultText,
            JSON.stringify(d.placeholders),
            d.fixedSuffix,
            d.order,
          ];
          if (
            have &&
            JSON.stringify([
              have.plugin,
              have.role,
              have.title,
              have.description,
              have.when_sent,
              have.audience,
              have.default_text,
              have.placeholders_json,
              have.fixed_suffix,
              have.sort_order,
            ]) === JSON.stringify(next)
          )
            continue;
          db.prepare(
            `INSERT INTO prompt_template (key, plugin, role, title, description, when_sent, audience,
               default_text, placeholders_json, fixed_suffix, sort_order, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET plugin = excluded.plugin, role = excluded.role,
               title = excluded.title, description = excluded.description, when_sent = excluded.when_sent,
               audience = excluded.audience, default_text = excluded.default_text,
               placeholders_json = excluded.placeholders_json, fixed_suffix = excluded.fixed_suffix,
               sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
          ).run(d.key, ...(next as SqlParam[]), iso());
        }
        if (options.pruneMissing && parsed.length > 0) {
          const keep = new Set(parsed.map((d) => d.key));
          for (const plugin of new Set(parsed.map((d) => d.plugin))) {
            for (const row of db
              .prepare<{ key: string }>("SELECT key FROM prompt_template WHERE plugin = ?")
              .all(plugin)) {
              if (!keep.has(row.key)) db.prepare("DELETE FROM prompt_template WHERE key = ?").run(row.key);
            }
          }
        }
      });
    },

    /** The raw body in effect (project override > global override > default), not rendered. */
    body(
      key: string,
      options: { projectId?: string | null } = {},
    ): { text: string; source: PromptSource } {
      const t = mustTemplate(key);
      const project = options.projectId ? overrideText(key, options.projectId) : null;
      if (project !== null) return { text: project, source: "project" };
      const global = overrideText(key, null);
      if (global !== null) return { text: global, source: "global" };
      return { text: t.default_text, source: "default" };
    },

    /** Body in effect, `{{placeholders}}` rendered once, then the fixed suffix appended. */
    resolve(
      key: string,
      options: { projectId?: string | null; vars?: Record<string, string> } = {},
    ): string {
      const t = mustTemplate(key);
      const { text } = prompts.body(key, options);
      // A prompt without declared placeholders is used verbatim (rules text may contain "{{").
      const declared = JSON.parse(t.placeholders_json) as unknown[];
      const body = declared.length > 0 ? renderPromptTemplate(text, options.vars ?? {}) : text;
      return composePrompt(body, t.fixed_suffix);
    },

    /** Set (or with blank text, clear) an override. `projectId` null/omitted = global. */
    setOverride(key: string, text: string, options: { projectId?: string | null } = {}): void {
      write((hlc) => {
        mustTemplate(key);
        const projectId = options.projectId ?? null;
        if (
          projectId !== null &&
          !db.prepare("SELECT 1 AS x FROM project WHERE id = ?").get(projectId)
        )
          throw new CommandError("not_found", `Project not found: ${projectId}`);
        if (text.length > PROMPT_OVERRIDE_MAX_CHARS)
          throw new CommandError(
            "invalid",
            `Prompt override too long (max ${PROMPT_OVERRIDE_MAX_CHARS} characters)`,
          );
        const value = text.trim() ? text : "";
        const id = promptOverrideId(key, projectId);
        const row = db.prepare<{ text: string }>("SELECT text FROM prompt_override WHERE id = ?").get(id);
        if (row ? row.text === value : !value) return;
        db.prepare(
          `INSERT INTO prompt_override (id, key, project_id, text, created_at, updated_at, updated_hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at,
             updated_hlc = excluded.updated_hlc`,
        ).run(id, key, projectId, value, iso(), iso(), hlc);
        stampFields("prompt_override", id, ["text"], hlc);
      });
    },

    /** Back to the default (for a project override: to the global one). */
    clearOverride(key: string, options: { projectId?: string | null } = {}): void {
      prompts.setOverride(key, "", options);
    },

    /** Every registered prompt, with overrides and the source of the text in effect. */
    list(options: { projectId?: string | null } = {}): PromptInfo[] {
      const rows = db.prepare<TemplateRow>("SELECT * FROM prompt_template").all();
      const overrides = db
        .prepare<{ key: string; project_id: string | null; text: string }>(
          "SELECT key, project_id, text FROM prompt_override WHERE text <> ''",
        )
        .all();
      return rows
        .map((r): PromptInfo => {
          const mine = overrides.filter((o) => o.key === r.key);
          const globalOverride = mine.find((o) => o.project_id === null)?.text ?? null;
          const projectOverride = options.projectId
            ? (mine.find((o) => o.project_id === options.projectId)?.text ?? null)
            : null;
          const source: PromptSource =
            projectOverride !== null ? "project" : globalOverride !== null ? "global" : "default";
          return {
            key: r.key,
            plugin: r.plugin,
            role: r.role as PromptInfo["role"],
            title: r.title,
            description: r.description,
            whenSent: r.when_sent,
            audience: r.audience,
            defaultText: r.default_text,
            placeholders: JSON.parse(r.placeholders_json),
            fixedSuffix: r.fixed_suffix,
            order: r.sort_order,
            globalOverride,
            projectOverride,
            source,
            effectiveText: projectOverride ?? globalOverride ?? r.default_text,
            overriddenProjects: mine.filter((o) => o.project_id !== null).map((o) => o.project_id!),
          };
        })
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    },
  };

  return { projects, presets, tags, cards, events, plans, sessions, gitSnapshots, prompts, deviceId, db };
}
