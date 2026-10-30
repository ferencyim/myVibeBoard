import {
  presetModels,
  type Preset,
  type PresetEnvironmentKind,
  type PresetModel,
  type PresetPermissionMode,
} from "../../shared/vibe/contract";

/** Everything one task role stores: model, prompt, fallback models, permission and environment. */
export interface RoleDraft {
  provider: string;
  model: string;
  thinking: string;
  fastMode: boolean;
  instructions: string;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string | null;
  runtimeEnv: string | null;
  /** Fallback models, tried in order after the primary one. */
  backups: PresetModel[];
}

export const EMPTY_ROLE_DRAFT: RoleDraft = {
  provider: "",
  model: "",
  thinking: "",
  fastMode: false,
  instructions: "",
  permissionMode: "accept-edits",
  environmentKind: "new-worktree",
  baseBranch: null,
  runtimeEnv: null,
  backups: [],
};

export function roleDraftOf(setting: Preset | undefined): RoleDraft {
  if (!setting) return EMPTY_ROLE_DRAFT;
  const [first, ...backups] = presetModels(setting);
  return {
    provider: first?.provider ?? setting.provider,
    model: first?.model ?? setting.model,
    thinking: first?.thinking ?? setting.thinking,
    fastMode: setting.fastMode === true,
    instructions: setting.instructions,
    permissionMode: first?.permissionMode ?? setting.permissionMode,
    environmentKind: setting.environmentKind,
    baseBranch: setting.baseBranch,
    runtimeEnv: setting.runtimeEnv,
    backups,
  };
}

/** Role settings are stored per scope ("global" or a project id) and role; the planner list uses planners.N. */
export function roleOwner(scope: string, role: string) {
  return { ownerScope: scope, ownerRole: role };
}

export function isOwnedBy(setting: Preset | undefined, scope: string, role: string): boolean {
  return setting?.ownerScope === scope && setting.ownerRole === role;
}

/** RPC body that stores a draft; `models[0]` mirrors the primary fields. */
export function roleSettingBody(draft: RoleDraft) {
  const first: PresetModel = {
    provider: draft.provider,
    model: draft.model,
    thinking: draft.thinking,
    permissionMode: draft.permissionMode,
  };
  return {
    provider: first.provider,
    model: first.model,
    thinking: first.thinking,
    permissionMode: first.permissionMode,
    models: [first, ...draft.backups],
    environmentKind: draft.environmentKind,
    baseBranch: draft.baseBranch,
    runtimeEnv: draft.runtimeEnv,
    instructions: draft.instructions,
    fastMode: draft.fastMode,
    roleHints: [],
  };
}

/** A name nobody else uses: "<scope>/<role>", then "(2)", "(3)". */
export function roleSettingName(taken: readonly string[], scopeLabel: string, role: string): string {
  const stem = `${scopeLabel}/${role}`;
  const lower = new Set(taken.map((name) => name.toLowerCase()));
  let name = stem;
  for (let n = 2; lower.has(name.toLowerCase()); n += 1) name = `${stem} (${n})`;
  return name;
}

export interface RoleSettingApi {
  create(body: ReturnType<typeof roleSettingBody> & ReturnType<typeof roleOwner> & { name: string }): Promise<Preset>;
  update(id: string, body: ReturnType<typeof roleSettingBody>): Promise<Preset>;
}

/** Stores a role's draft and returns the setting id the defaults should point at. A setting this
 *  scope and role already owns is edited in place; anything else (shared legacy rows, another
 *  role's row) is copied, so editing one role never changes another. */
export async function saveRoleSetting(input: {
  api: RoleSettingApi;
  settings: readonly Preset[];
  current: Preset | undefined;
  draft: RoleDraft;
  scope: string;
  scopeLabel: string;
  role: string;
}): Promise<string> {
  const { api, settings, current, draft, scope, scopeLabel, role } = input;
  if (!draft.provider.trim() || !draft.model.trim()) throw new Error("请先选择模型");
  const body = roleSettingBody(draft);
  if (current && isOwnedBy(current, scope, role)) return (await api.update(current.id, body)).id;
  const name = roleSettingName(
    settings.map((setting) => setting.name),
    scopeLabel,
    role,
  );
  return (await api.create({ ...body, ...roleOwner(scope, role), name })).id;
}

/** The scope label shown in setting names: global or the project's name. */
export function scopeKey(projectId: string | undefined): string {
  return projectId ?? "global";
}
