// Read side of the local RPC: live rows of the replica -> the same domain objects the daemon's
// vibe-board RPCs return (generated/contract/model.ts). Synced values are raw SQLite cells
// (snake_case, 0/1 flags, `*_json` text); columns the daemon did not publish get safe defaults.

import {
  ROLE_HINTS,
  parseHlc,
  type AgentSession,
  type CardEvent,
  type CardView,
  type PlanVersion,
  type Preset,
  type Project,
  type Tag,
} from "../generated/contract";
import { ROW_MARKER, isResurrectable, type JsonValue } from "../generated/sync";
import type { SqliteChangeStore } from "../store/change-store";

export interface RawRow {
  id: string;
  v: Record<string, JsonValue>;
  /** Largest HLC wall time (ms) among the row's fields: "last changed" before the daemon says. */
  wall: number;
}

/** Live (not deleted) rows of a table, keyed by row id. */
export function liveRows(store: SqliteChangeStore, table: string): RawRow[] {
  const tombs = store.tableTombstones(table);
  const resurrectable = isResurrectable(table);
  const out: RawRow[] = [];
  for (const [id, fields] of store.tableFields(table)) {
    const tomb = tombs.get(id);
    if (resurrectable) {
      const marker = fields[ROW_MARKER];
      if (!marker || (tomb !== undefined && marker.hlc <= tomb)) continue;
    } else if (tomb !== undefined) {
      continue;
    }
    const v: Record<string, JsonValue> = {};
    let wall = 0;
    for (const [column, f] of Object.entries(fields)) {
      if (column !== ROW_MARKER) v[column] = f.value;
      wall = Math.max(wall, parseHlc(f.hlc).wall);
    }
    out.push({ id, v, wall });
  }
  return out;
}

const str = (x: JsonValue | undefined, fallback = ""): string =>
  typeof x === "string" ? x : fallback;
const strOrNull = (x: JsonValue | undefined): string | null => (typeof x === "string" ? x : null);
const int = (x: JsonValue | undefined, fallback: number): number =>
  typeof x === "number" ? x : fallback;
const intOrNull = (x: JsonValue | undefined): number | null => (typeof x === "number" ? x : null);
const flag = (x: JsonValue | undefined): boolean => x === 1 || x === true;

function json<T>(x: JsonValue | undefined, fallback: T): T {
  if (typeof x !== "string") return fallback;
  try {
    return JSON.parse(x) as T;
  } catch {
    return fallback;
  }
}

const iso = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : "");

/** Fallback project prefix for a daemon that does not publish it. */
function derivePrefix(name: string): string {
  return (
    name
      .replace(/[^A-Za-z]/g, "")
      .slice(0, 4)
      .toUpperCase() || "P"
  );
}

/** project_types_json, or the single project_type written by an older daemon/phone. */
function projectTypesOf(v: RawRow["v"]): Project["projectTypes"] {
  const types = json<Project["projectTypes"]>(v.project_types_json, []);
  return types.length ? types : [str(v.project_type, "other") as Project["projectType"]];
}

function roleHintsOf(v: RawRow["v"]): Preset["roleHints"] {
  const hints = json<Preset["roleHints"]>(v.role_hints_json, []);
  const legacy = strOrNull(v.role_hint) as Preset["roleHints"][number];
  return hints.length || !ROLE_HINTS.includes(legacy) ? hints : [legacy];
}

export function toProject(r: RawRow): Project {
  const name = str(r.v.name, r.id);
  return {
    id: r.id,
    name,
    prefix: str(r.v.prefix) || derivePrefix(name),
    repoPath: str(r.v.repo_path),
    projectTypes: projectTypesOf(r.v),
    projectType: str(r.v.project_type, "other") as Project["projectType"], // COMPAT(project-types)
    description: str(r.v.description),
    requirementsPath: str(r.v.requirements_path) || "PRODUCT-REQUIREMENTS.md",
    defaultPresetId: strOrNull(r.v.default_preset_id),
    concurrencyLimit: intOrNull(r.v.concurrency_limit),
    devices: json<string[]>(r.v.devices_json, []),
    paseoProjectId: strOrNull(r.v.paseo_project_id),
    color: strOrNull(r.v.color),
    nextNumber: int(r.v.next_number, 1),
    createdAt: str(r.v.created_at) || iso(r.wall),
    updatedAt: str(r.v.updated_at) || iso(r.wall),
    archivedAt: strOrNull(r.v.archived_at),
    updatedHlc: "",
  };
}

/** Key shown for a card the daemon has not numbered yet (also resolvable after it gets one). */
export function provisionalKey(prefix: string, cardId: string): string {
  return `${prefix}-${cardId.slice(-5)}`;
}

export function toCard(r: RawRow, prefix: string, tags: string[]): CardView {
  const created = Date.parse(str(r.v.created_at)) || 0;
  const updated = Math.max(Date.parse(str(r.v.updated_at)) || 0, r.wall);
  return {
    id: r.id,
    projectId: str(r.v.project_id),
    number: int(r.v.number, 0),
    key: str(r.v.key) || provisionalKey(prefix, r.id),
    title: str(r.v.title),
    description: str(r.v.description),
    column: str(r.v.column, "draft") as CardView["column"],
    sortKey: str(r.v.sort_key),
    priority: str(r.v.priority, "none") as CardView["priority"],
    acceptance: str(r.v.acceptance),
    refImages: json<string[]>(r.v.ref_images_json, []),
    needsEvidence: flag(r.v.needs_evidence),
    presetId: strOrNull(r.v.preset_id),
    suggestedPresetId: strOrNull(r.v.suggested_preset_id),
    reviewerPresetId: strOrNull(r.v.reviewer_preset_id),
    worktree: strOrNull(r.v.worktree),
    origin: str(r.v.origin, "manual") as CardView["origin"],
    originRef: strOrNull(r.v.origin_ref),
    dedupeKey: strOrNull(r.v.dedupe_key),
    planSessionId: strOrNull(r.v.plan_session_id),
    parentCardId: strOrNull(r.v.parent_card_id),
    archivedAt: strOrNull(r.v.archived_at),
    createdAt: iso(created || r.wall),
    updatedAt: iso(updated),
    updatedHlc: "",
    tags,
  };
}

export function toEvent(r: RawRow): CardEvent {
  return {
    id: r.id,
    cardId: str(r.v.card_id),
    type: str(r.v.type, "note") as CardEvent["type"],
    authorKind: str(r.v.author_kind, "user") as CardEvent["authorKind"],
    author: str(r.v.author),
    body: json<unknown>(r.v.body_json, {}),
    createdAt: str(r.v.created_at) || iso(r.wall),
    updatedHlc: "",
  };
}

export function toPreset(r: RawRow): Preset {
  return {
    id: r.id,
    name: str(r.v.name),
    provider: str(r.v.provider),
    model: str(r.v.model),
    thinking: str(r.v.thinking),
    permissionMode: str(r.v.permission_mode, "accept-edits") as Preset["permissionMode"],
    environmentKind: str(r.v.environment_kind, "project-default") as Preset["environmentKind"],
    baseBranch: strOrNull(r.v.base_branch),
    runtimeEnv: strOrNull(r.v.runtime_env),
    instructions: str(r.v.instructions),
    fallbackPresetIds: json<string[] | null>(r.v.fallback_preset_ids_json, null),
    roleHints: roleHintsOf(r.v),
    roleHint: strOrNull(r.v.role_hint), // COMPAT(preset-role-hints)
    builtin: flag(r.v.builtin),
    createdAt: str(r.v.created_at) || iso(r.wall),
    updatedAt: str(r.v.updated_at) || iso(r.wall),
    updatedHlc: "",
  };
}

export function toTag(r: RawRow): Tag {
  return {
    id: r.id,
    name: str(r.v.name),
    evidence: flag(r.v.evidence),
    builtin: flag(r.v.builtin),
    updatedHlc: "",
  };
}

export function toSession(r: RawRow): AgentSession {
  return {
    id: r.id,
    cardId: strOrNull(r.v.card_id),
    agentId: str(r.v.agent_id),
    workspaceId: strOrNull(r.v.workspace_id),
    role: str(r.v.role, "worker") as AgentSession["role"],
    currentProvider: str(r.v.current_provider),
    switchHistory: json<AgentSession["switchHistory"]>(r.v.switch_history_json, []),
    state: str(r.v.state, "idle") as AgentSession["state"],
    waitingSince: strOrNull(r.v.waiting_since),
    pendingQuestion: json<unknown>(r.v.pending_question_json, null),
    cacheExpiresAt: strOrNull(r.v.cache_expires_at),
    lastActivityAt: str(r.v.last_activity_at),
    startedAt: str(r.v.started_at),
    endedAt: strOrNull(r.v.ended_at),
    errorMessage: strOrNull(r.v.error_message),
    stalledSince: strOrNull(r.v.stalled_since),
    complexity: strOrNull(r.v.complexity) as AgentSession["complexity"],
    reassignedFromSessionId: strOrNull(r.v.reassigned_from_session_id),
    updatedHlc: "",
  };
}

export function toPlan(r: RawRow): PlanVersion {
  return {
    id: r.id,
    cardId: str(r.v.card_id),
    version: int(r.v.version, 1),
    snapshot: json<PlanVersion["snapshot"]>(r.v.snapshot_json, {
      description: "",
      checks: [],
      subCards: [],
      tags: [],
      recommendedPresetId: null,
    }),
    createdAt: str(r.v.created_at) || iso(r.wall),
  };
}
