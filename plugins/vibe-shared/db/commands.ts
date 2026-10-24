// Shared settings, task and session command layer. All writes use one transaction.

import {
  DEFAULT_MASTER_DISPATCH,
  MASTER_DISPATCH_KEY,
  MasterDispatchModeSchema,
  type MasterDispatchMode,
} from "../contract/dispatch";
import {
  DEFAULT_REQUIREMENTS_PATH,
  PROJECT_PREFIX_PATTERN,
  ROLE_HINTS,
  type PresetEnvironmentKind,
  type PresetPermissionMode,
  type ProjectType,
  type RoleHint,
  type SessionComplexity,
  type SessionRole,
  type SessionState,
} from "../contract/enums";
import { tickHlc, type Hlc } from "../contract/hlc";
import { newId } from "../contract/ids";
import {
  AgentSessionSchema,
  PresetModelInputSchema,
  PresetSchema,
  ProjectSchema,
  type AgentSession,
  type Preset,
  type PresetModel,
  type Project,
} from "../contract/model";
import {
  MODEL_ROLES,
  ModelDefaultsSchema,
  cleanDefaults,
  resolveTaskRoles,
  type ModelDefaults,
  type TaskRoleSelections,
  type TaskRoleSnapshot,
} from "../contract/model-roles";
import { isSafeRepoRelativePath } from "../contract/paths";
import { presetModels } from "../contract/preset-models";
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
import { assertSessionTransition } from "../contract/state-machine";
import {
  DEFAULT_SCHEDULER_LIMITS,
  SCHEDULER_LIMITS_KEY,
  SchedulerLimitsSchema,
  type SchedulerLimits,
} from "../contract/subtasks";
import { TASK_PLAN_PROMPT } from "../contract/task";
import { publishEvent } from "./events";
import { findProjectConfig } from "./project-config";
import { decodeRow, decodeRows } from "./rows";
import type { SqlParam, VibeDb } from "./sqlite";
import { createTaskArtifactCommands } from "./task-artifacts";
import { createTaskCommands } from "./tasks";

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
  /** Local writer identity used for monotonic update timestamps. */
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
  /** WP-108: default preset per model job (missing = follow the global default). Replaces defaultPresetId. */
  defaultPresets?: ModelDefaults;
  concurrencyLimit?: number | null;
  devices?: string[];
  paseoProjectId?: string | null;
  color?: string | null;
}
export type UpdateProjectInput = Partial<Omit<CreateProjectInput, "prefix">> & {
  archived?: boolean;
};

export interface CreatePresetInput {
  models?: PresetModel[];
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

export interface StartSessionInput {
  cardId?: null;
  projectId?: string | null;
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
  /** Preset used by the replacement. */
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

// --- store ------------------------------------------------------------------------------------

type Enc = (value: never) => SqlParam;
const asJson: Enc = (v) => JSON.stringify(v);
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
  defaultPresets: ["default_presets_json", (v) => JSON.stringify(cleanDefaults(v))],
  concurrencyLimit: ["concurrency_limit", asIs],
  devices: ["devices_json", asJson],
  paseoProjectId: ["paseo_project_id", asIs],
  color: ["color", asIs],
};
const PRESET_FIELDS: FieldMap = {
  models: ["models_json", asJson],
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
function normalizeProjectInput<
  T extends { projectTypes?: ProjectType[]; projectType?: ProjectType },
>(input: T): T {
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

export const MODEL_DEFAULTS_KEY = "models.defaults";

export type VibeStore = ReturnType<typeof createVibeStore>;

export function createVibeStore(db: VibeDb, storeOptions: StoreOptions = {}) {
  const now = storeOptions.now ?? (() => new Date());
  const iso = () => now().toISOString();
  let cachedDeviceId = storeOptions.deviceId;

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

  function mustProject(id: string): Project {
    const row = db.prepare("SELECT * FROM project WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Project not found: ${id}`);
    return decodeRow(ProjectSchema, row);
  }

  const write = <T>(fn: (hlc: Hlc) => T): T =>
    db.immediate(() => {
      const hlc = nextHlc();
      return fn(hlc);
    });

  // ---- model defaults ----

  function validateDefaults(value: ModelDefaults | undefined): void {
    if (value === undefined) return;
    const parsed = ModelDefaultsSchema.parse(value);
    for (const role of MODEL_ROLES) {
      const id = parsed[role]?.trim();
      if (id && !presets.get(id)) throw new CommandError("not_found", `Preset not found: ${id}`);
    }
  }

  const projects = {
    create(rawInput: CreateProjectInput): Project {
      const input = normalizeProjectInput(rawInput);
      checkRequirementsPath(input.requirementsPath);
      validateDefaults(input.defaultPresets);
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
               requirements_path, default_presets_json, concurrency_limit,
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
            JSON.stringify(cleanDefaults(input.defaultPresets ?? {})),
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
        return mustProject(id);
      });
    },
    update(id: string, rawPatch: UpdateProjectInput): Project {
      const patch = normalizeProjectInput(rawPatch);
      checkRequirementsPath(patch.requirementsPath);
      validateDefaults(patch.defaultPresets);
      return write((hlc) => {
        mustProject(id);
        const { archived, ...rest } = patch;
        patchRow("project", id, PROJECT_FIELDS, rest, hlc);
        if (archived !== undefined) {
          db.prepare(
            "UPDATE project SET archived_at = ?, updated_at = ?, updated_hlc = ? WHERE id = ?",
          ).run(archived ? iso() : null, iso(), hlc, id);
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

  // Project extensions share the existing row; callers use the native project ID.
  const projectConfigs = {
    get(paseoProjectId: string): Project | undefined {
      return findProjectConfig(projects.list(true), paseoProjectId);
    },
    link(paseoProjectId: string, repoPath: string): Project | undefined {
      return db.immediate(() => {
        const project = findProjectConfig(projects.list(true), paseoProjectId, repoPath);
        if (!project || project.paseoProjectId === paseoProjectId) return project;
        return projects.update(project.id, { paseoProjectId });
      });
    },
    update(
      paseoProjectId: string,
      patch: Pick<
        UpdateProjectInput,
        | "projectTypes"
        | "description"
        | "requirementsPath"
        | "concurrencyLimit"
        | "devices"
        | "defaultPresets"
      >,
    ): Project {
      return db.immediate(() => {
        const project = projectConfigs.get(paseoProjectId);
        if (!project) throw new CommandError("not_found", "项目扩展配置不存在：" + paseoProjectId);
        return projects.update(project.id, patch);
      });
    },
  };

  // ---- presets & tags ----

  function mustPreset(id: string): Preset {
    const row = db.prepare("SELECT * FROM preset WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Preset not found: ${id}`);
    return decodeRow(PresetSchema, row);
  }

  function legacyPresetModels(first: PresetModel, fallbackIds: string[]): PresetModel[] {
    const models = [first];
    const visited = new Set<string>();
    const seen = new Set([JSON.stringify(first)]);
    function append(id: string): void {
      if (visited.has(id)) return;
      visited.add(id);
      const preset = presets.get(id);
      if (!preset) return;
      for (const candidate of presetModels(preset)) {
        const key = JSON.stringify(candidate);
        if (!seen.has(key)) {
          seen.add(key);
          models.push(candidate);
        }
      }
      for (const next of preset.fallbackPresetIds ?? []) append(next);
    }
    for (const id of fallbackIds) append(id);
    return models;
  }

  const presets = {
    create(rawInput: CreatePresetInput): Preset {
      const input = normalizePresetInput(rawInput);
      const candidates =
        input.models ??
        legacyPresetModels(
          {
            provider: input.provider,
            model: input.model,
            thinking: input.thinking ?? "",
            permissionMode: input.permissionMode ?? "accept-edits",
          },
          input.fallbackPresetIds ?? [],
        );
      const models = PresetModelInputSchema.array().min(1).parse(candidates);
      const first = models[0]!;
      return write((hlc) => {
        const id = input.id ?? newId(now().getTime());
        try {
          db.prepare(
            `INSERT INTO preset (id, name, provider, model, thinking, permission_mode, environment_kind, base_branch,
               runtime_env, instructions, fallback_preset_ids_json, role_hint, role_hints_json, builtin, created_at, updated_at, updated_hlc, models_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            input.name,
            first.provider,
            first.model,
            first.thinking,
            first.permissionMode,
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
            JSON.stringify(models),
          );
        } catch (error) {
          if (String(error).includes("UNIQUE"))
            throw new CommandError("conflict", `Preset "${input.name}" already exists`);
          throw error;
        }
        return mustPreset(id);
      });
    },
    update(id: string, rawPatch: UpdatePresetInput): Preset {
      const patch = normalizePresetInput(rawPatch);
      return write((hlc) => {
        const current = mustPreset(id);
        const { builtin: _ignored, ...rest } = patch;
        const editsModel = ["provider", "model", "thinking", "permissionMode"].some((field) =>
          Object.hasOwn(patch, field),
        );
        if (patch.models !== undefined) {
          const models = PresetModelInputSchema.array().min(1).parse(patch.models);
          Object.assign(rest, models[0], { models });
        } else if (editsModel || patch.fallbackPresetIds !== undefined) {
          const models = [...presetModels(current)];
          models[0] = PresetModelInputSchema.parse({ ...models[0], ...rest });
          const candidates =
            patch.fallbackPresetIds === undefined
              ? models
              : legacyPresetModels(models[0], patch.fallbackPresetIds ?? []);
          Object.assign(rest, models[0], { models: candidates });
        }
        patchRow("preset", id, PRESET_FIELDS, rest, hlc);
        return mustPreset(id);
      });
    },
    delete(id: string): void {
      write((hlc) => {
        mustPreset(id);
        // WP-108: forget the preset in the project and global default models.
        for (const p of projects.list(true)) {
          const kept = Object.fromEntries(
            Object.entries(p.defaultPresets).filter(([, v]) => v !== id),
          );
          if (Object.keys(kept).length !== Object.keys(p.defaultPresets).length)
            patchRow("project", p.id, PROJECT_FIELDS, { defaultPresets: kept }, hlc);
        }
        const globals = modelDefaults.global();
        if (Object.values(globals).includes(id))
          writeGlobalDefaults(
            Object.fromEntries(Object.entries(globals).filter(([, v]) => v !== id)),
          );
        db.prepare("DELETE FROM preset WHERE id = ?").run(id);
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

  // ---- agent sessions ----

  function mustSession(id: string): AgentSession {
    const row = db.prepare("SELECT * FROM agent_session WHERE id = ?").get(id);
    if (!row) throw new CommandError("not_found", `Session not found: ${id}`);
    return decodeRow(AgentSessionSchema, row);
  }

  function insertSession(input: StartSessionInput, hlc: Hlc): AgentSession {
    if (input.cardId != null)
      throw new CommandError("invalid", "旧卡片入口已停用，请在 workspace 中发起任务");
    const id = newId(now().getTime());
    try {
      db.prepare(
        `INSERT INTO agent_session (id, card_id, agent_id, workspace_id, role, current_provider, state,
           last_activity_at, started_at, complexity, reassigned_from_session_id, updated_hlc, project_id)
         VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        null,
        input.agentId,
        input.workspaceId ?? null,
        input.role,
        input.provider,
        iso(),
        iso(),
        input.complexity ?? null,
        input.reassignedFromSessionId ?? null,
        hlc,
        input.projectId ?? null,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new CommandError("conflict", `Agent already has a session: ${input.agentId}`);
      throw error;
    }

    emit(
      "session.started",
      { sessionId: id, agentId: input.agentId, role: input.role, provider: input.provider },
      { cardId: input.cardId, projectId: input.projectId ?? null },
    );
    return mustSession(id);
  }

  /** Publish the durable native session state notification. */
  function announceSessionState(
    s: AgentSession,
    to: SessionState,
    opts: SetSessionStateOptions,
    _hlc: Hlc,
  ): void {
    const refs = { cardId: s.cardId, projectId: s.projectId ?? null };
    const base = { sessionId: s.id, agentId: s.agentId };
    if (to === "waiting") emit("session.waiting", { ...base, question: opts.question }, refs);
    else if (to === "working" && s.state === "waiting") emit("session.answered", base, refs);
    else if (to === "ended") emit("session.ended", { ...base, outcome: opts.outcome }, refs);
    else if (to === "error") {
      emit("session.error", { ...base, message: opts.message ?? "unknown error" }, refs);
    }
  }

  function announceUnstalled(s: AgentSession, _hlc: Hlc): void {
    emit(
      "session.unstalled",
      { sessionId: s.id, agentId: s.agentId },
      { cardId: s.cardId, projectId: s.projectId ?? null },
    );
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
          { cardId: s.cardId, projectId: s.projectId ?? null },
        );

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
          { cardId: s.cardId, projectId: s.projectId ?? null },
        );
        return mustSession(id);
      });
    },

    /** Atomically end a session and register its replacement. */
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
            projectId: old.projectId,
            agentId: input.agentId,
            workspaceId: input.workspaceId,
            role: old.role,
            provider: input.provider,
            complexity: old.complexity,
            reassignedFromSessionId: old.id,
          },
          hlc,
        );

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
          { cardId: old.cardId, projectId: old.projectId ?? null },
        );
        return { from: ended, to: next };
      });
    },

    /** Provider switch inside a session, retained in history. */
    switchProvider(id: string, to: string, reason?: string): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);
        if (s.currentProvider === to) return s;
        const history = [...s.switchHistory, { from: s.currentProvider, to, at: iso(), reason }];
        db.prepare(
          "UPDATE agent_session SET current_provider = ?, switch_history_json = ?, updated_hlc = ? WHERE id = ?",
        ).run(to, JSON.stringify(history), hlc, id);

        emit(
          "session.switched",
          { sessionId: id, agentId: s.agentId, from: s.currentProvider, to },
          { cardId: s.cardId, projectId: s.projectId ?? null },
        );
        return mustSession(id);
      });
    },

    recordCompaction(id: string, strategy = "compact"): AgentSession {
      return write((hlc) => {
        const s = mustSession(id);

        db.prepare("UPDATE agent_session SET updated_hlc = ? WHERE id = ?").run(hlc, id);
        emit(
          "session.compacted",
          { sessionId: id, agentId: s.agentId, strategy },
          { cardId: s.cardId, projectId: s.projectId ?? null },
        );
        return mustSession(id);
      });
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
          const have = db
            .prepare<TemplateRow>("SELECT * FROM prompt_template WHERE key = ?")
            .get(d.key);
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
              if (!keep.has(row.key))
                db.prepare("DELETE FROM prompt_template WHERE key = ?").run(row.key);
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
        const row = db
          .prepare<{ text: string }>("SELECT text FROM prompt_override WHERE id = ?")
          .get(id);
        if (row ? row.text === value : !value) return;
        db.prepare(
          `INSERT INTO prompt_override (id, key, project_id, text, created_at, updated_at, updated_hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at,
             updated_hlc = excluded.updated_hlc`,
        ).run(id, key, projectId, value, iso(), iso(), hlc);
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
          let source: PromptSource = "default";
          if (globalOverride !== null) source = "global";
          if (projectOverride !== null) source = "project";
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

  // ---- scheduler limits (WP-106): vibe-scheduler publishes, the board checks sub-agent starts ----

  const limits = {
    publish(value: SchedulerLimits): void {
      const parsed = SchedulerLimitsSchema.parse(value);
      db.prepare(
        "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(SCHEDULER_LIMITS_KEY, JSON.stringify(parsed));
    },
    get(): SchedulerLimits {
      const raw = db
        .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?")
        .get(SCHEDULER_LIMITS_KEY)?.value;
      if (!raw) return DEFAULT_SCHEDULER_LIMITS;
      try {
        return SchedulerLimitsSchema.parse(JSON.parse(raw));
      } catch {
        return DEFAULT_SCHEDULER_LIMITS;
      }
    },
  };

  // ---- default models (WP-108): the global level; the project level is project.defaultPresets ----

  function writeGlobalDefaults(value: ModelDefaults): void {
    db.prepare(
      "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(MODEL_DEFAULTS_KEY, JSON.stringify(cleanDefaults(value)));
  }

  const modelDefaults = {
    resolveTask(selections: TaskRoleSelections, paseoProjectId?: string): TaskRoleSnapshot {
      return db.immediate(() =>
        resolveTaskRoles(
          selections,
          paseoProjectId ? projectConfigs.get(paseoProjectId)?.defaultPresets : undefined,
          modelDefaults.global(),
          presets.get,
        ),
      );
    },

    global(): ModelDefaults {
      const raw = db
        .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?")
        .get(MODEL_DEFAULTS_KEY)?.value;
      if (!raw) return {};
      try {
        return cleanDefaults(JSON.parse(raw));
      } catch {
        return {};
      }
    },
    /** Replaces the global defaults; unknown preset ids are refused. */
    setGlobal(value: ModelDefaults): ModelDefaults {
      validateDefaults(value);
      const clean = cleanDefaults(value);
      for (const role of MODEL_ROLES) {
        const id = clean[role];
        if (id && !presets.get(id)) throw new CommandError("not_found", `Preset not found: ${id}`);
      }
      writeGlobalDefaults(clean);
      return clean;
    },
  };

  // ---- master dispatch mode (WP-109): vibe-master publishes, vibe-scheduler reads ----

  const masterDispatch = {
    publish(value: MasterDispatchMode): void {
      const parsed = MasterDispatchModeSchema.parse(value);
      db.prepare(
        "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(MASTER_DISPATCH_KEY, JSON.stringify(parsed));
    },
    get(): MasterDispatchMode {
      const raw = db
        .prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?")
        .get(MASTER_DISPATCH_KEY)?.value;
      if (!raw) return DEFAULT_MASTER_DISPATCH;
      try {
        return MasterDispatchModeSchema.parse(JSON.parse(raw));
      } catch {
        return DEFAULT_MASTER_DISPATCH;
      }
    },
  };

  const taskCommands = createTaskCommands(db, { now });
  const tasks = {
    ...taskCommands,
    create(input: Parameters<typeof taskCommands.create>[0]) {
      return db.immediate(() => {
        prompts.register([TASK_PLAN_PROMPT]);
        return taskCommands.create(input);
      });
    },
  };
  return {
    projects,
    projectConfigs,
    tasks,
    taskArtifacts: createTaskArtifactCommands(db, { now }),
    presets,
    sessions,
    prompts,
    limits,
    masterDispatch,
    modelDefaults,
    deviceId,
    db,
  };
}
