// Pure preset / usage helpers (WP-14). No React imports.

import {
  DEFAULT_REQUIREMENTS_PATH,
  ROLE_HINTS,
  isSafeRepoRelativePath,
  type Preset,
  type PresetEnvironmentKind,
  type PresetPermissionMode,
  type Project,
  type ProjectType,
  type RoleHint,
} from "../../shared/vibe/contract";

/** Subset of the daemon's ProviderUsage that the picker needs (structural, tolerant). */
export interface UsageWindowLike {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  usedPct?: number | null;
  remainingPct?: number | null;
}
export interface ProviderUsageLike {
  providerId: string;
  displayName: string;
  status: "available" | "unavailable" | "error";
  windows: UsageWindowLike[];
}

export interface QuotaInfo {
  /** e.g. "5h 73%" */
  text: string;
  remainingPct: number;
  tone: "ok" | "warning" | "danger";
}

function remaining(w: UsageWindowLike): number | null {
  if (typeof w.remainingPct === "number") return w.remainingPct;
  if (typeof w.usedPct === "number") return 100 - w.usedPct;
  return null;
}

/** Remaining quota of one provider: the tightest window with data. null = unknown. */
export function quotaFor(
  providerId: string,
  usage: readonly ProviderUsageLike[] | null | undefined,
): QuotaInfo | null {
  const entry = usage?.find((u) => u.providerId === providerId);
  if (!entry || entry.status !== "available") return null;
  const windows = entry.windows
    .map((w) => ({ w, pct: remaining(w) }))
    .filter((x): x is { w: UsageWindowLike; pct: number } => x.pct !== null);
  if (windows.length === 0) return null;
  const tightest = windows.reduce((a, b) => (b.pct < a.pct ? b : a));
  const pct = Math.max(0, Math.min(100, Math.round(tightest.pct)));
  const label = tightest.w.shortLabel ?? tightest.w.label;
  return {
    text: `${label ? `${label} ` : ""}${pct}%`,
    remainingPct: pct,
    tone: pct <= 10 ? "danger" : pct <= 30 ? "warning" : "ok",
  };
}

// --- preset form -----------------------------------------------------------------------------

export const PERMISSION_LABELS: Record<PresetPermissionMode, string> = {
  "accept-edits": "接受编辑",
  auto: "自动",
  full: "完全放行",
};
export const ENVIRONMENT_LABELS: Record<PresetEnvironmentKind, string> = {
  "project-default": "项目默认目录",
  "new-worktree": "新建 worktree",
};

/** Preset purposes (multi-select; none selected = unspecified). */
export const ROLE_HINT_LABELS: Record<RoleHint, string> = {
  worker: "执行",
  scout: "探路",
  reviewer: "复核",
};

export interface PresetDraft {
  name: string;
  provider: string;
  model: string;
  /** Thinking level id; "" = default (not specified). */
  thinking: string;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string;
  runtimeEnv: string;
  instructions: string;
  /** Ordered preset ids to continue on when an agent on this preset fails (quota, login, ...). */
  fallbackPresetIds: string[];
  roleHints: RoleHint[];
}

export const EMPTY_PRESET_DRAFT: PresetDraft = {
  name: "",
  provider: "",
  model: "",
  thinking: "",
  permissionMode: "accept-edits",
  environmentKind: "new-worktree",
  baseBranch: "",
  runtimeEnv: "",
  instructions: "",
  fallbackPresetIds: [],
  roleHints: [],
};

export function presetToDraft(p: Preset): PresetDraft {
  return {
    name: p.name,
    provider: p.provider,
    model: p.model,
    thinking: p.thinking,
    permissionMode: p.permissionMode,
    environmentKind: p.environmentKind,
    baseBranch: p.baseBranch ?? "",
    runtimeEnv: p.runtimeEnv ?? "",
    instructions: p.instructions,
    fallbackPresetIds: p.fallbackPresetIds ?? [],
    roleHints: [...p.roleHints],
  };
}

/** Toggle `id` in the ordered chain: selecting appends (order = click order), selecting again removes. */
export function toggleFallback(chain: readonly string[], id: string): string[] {
  return chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id];
}

/** Draft -> RPC payload (blank optional strings become null). */
export function draftToPayload(d: PresetDraft) {
  return {
    name: d.name.trim(),
    provider: d.provider.trim(),
    model: d.model.trim(),
    thinking: d.thinking.trim(),
    permissionMode: d.permissionMode,
    environmentKind: d.environmentKind,
    baseBranch: d.baseBranch.trim() || null,
    runtimeEnv: d.runtimeEnv.trim() || null,
    instructions: d.instructions,
    fallbackPresetIds: d.fallbackPresetIds.length ? d.fallbackPresetIds : null,
    roleHints: d.roleHints,
  };
}

/** Toggle a purpose; the result keeps the canonical ROLE_HINTS order. */
export function toggleRoleHint(hints: readonly RoleHint[], hint: RoleHint): RoleHint[] {
  const next = hints.includes(hint) ? hints.filter((h) => h !== hint) : [...hints, hint];
  return ROLE_HINTS.filter((h) => next.includes(h));
}

export interface ThinkingOption {
  id: string;
  label: string;
}
/** Model fields of providersCatalog that matter for the thinking picker. */
export interface ModelLike {
  id: string;
  thinkingOptions?: readonly ThinkingOption[];
}

export const DEFAULT_THINKING_OPTION: ThinkingOption = { id: "", label: "默认" };

/** Thinking levels of the chosen model, in daemon order. [] when unknown / no choice. */
export function modelThinkingOptions(models: readonly ModelLike[], modelId: string): ThinkingOption[] {
  return [...(models.find((m) => m.id === modelId)?.thinkingOptions ?? [])];
}

/** Single-select choices: "默认" + the model's levels; a saved value the model does not list is kept as an extra. */
export function thinkingChoices(
  models: readonly ModelLike[],
  modelId: string,
  current: string,
): ThinkingOption[] {
  const options = modelThinkingOptions(models, modelId);
  const choices = [DEFAULT_THINKING_OPTION, ...options];
  if (current && !options.some((o) => o.id === current)) choices.push({ id: current, label: `${current}（当前值）` });
  return choices;
}

/** After the model changed: keep `current` only if the new model offers it, else back to default. */
export function thinkingAfterModelChange(
  models: readonly ModelLike[],
  newModelId: string,
  current: string,
): string {
  return modelThinkingOptions(models, newModelId).some((o) => o.id === current) ? current : "";
}

// --- project form ----------------------------------------------------------------------------

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  android: "安卓",
  ios: "iOS",
  web: "Web",
  desktop: "桌面",
  backend: "后端",
  embedded: "嵌入式",
  other: "其它",
};

export interface ProjectDraft {
  name: string;
  /** Create only; read-only once the project exists. */
  prefix: string;
  repoPath: string;
  /** Non-empty at save time; the first is the primary type. */
  projectTypes: ProjectType[];
  description: string;
  requirementsPath: string;
  defaultPresetId: string | null;
  /** "" = unlimited. */
  concurrencyLimit: string;
  /** Comma / newline separated device ids. */
  devices: string;
  color: string;
}

export function emptyProjectDraft(color: string): ProjectDraft {
  return {
    name: "",
    prefix: "",
    repoPath: "",
    projectTypes: [],
    description: "",
    requirementsPath: DEFAULT_REQUIREMENTS_PATH,
    defaultPresetId: null,
    concurrencyLimit: "",
    devices: "",
    color,
  };
}

export function projectToDraft(p: Project, fallbackColor: string): ProjectDraft {
  return {
    name: p.name,
    prefix: p.prefix,
    repoPath: p.repoPath,
    projectTypes: [...p.projectTypes],
    description: p.description,
    requirementsPath: p.requirementsPath,
    defaultPresetId: p.defaultPresetId,
    concurrencyLimit: p.concurrencyLimit === null ? "" : String(p.concurrencyLimit),
    devices: p.devices.join(", "),
    color: p.color ?? fallbackColor,
  };
}

/** Toggle a type; selection order is kept (the first one is the primary type). */
export function toggleProjectType(types: readonly ProjectType[], type: ProjectType): ProjectType[] {
  return types.includes(type) ? types.filter((t) => t !== type) : [...types, type];
}

export function parseDevices(text: string): string[] {
  return [...new Set(text.split(/[,，\n]/).map((d) => d.trim()).filter(Boolean))];
}

function parseConcurrency(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  return /^\d+$/.test(t) && Number(t) >= 1 ? Number(t) : undefined;
}

export function validateProjectDraft(d: ProjectDraft, mode: "create" | "edit"): string | null {
  if (!d.name.trim()) return "请填写项目名称";
  if (mode === "create" && !d.prefix.trim()) return "请填写前缀";
  if (d.projectTypes.length === 0) return "请至少选择一个项目类型";
  if (!isSafeRepoRelativePath(d.requirementsPath.trim())) return "需求文档路径必须是仓库内的相对路径（不能含 ..）";
  if (parseConcurrency(d.concurrencyLimit) === undefined) return "并发上限须为不小于 1 的整数，或留空";
  return null;
}

/** Fields shared by projects.create and projects.update (prefix excluded). */
export function projectDraftToPayload(d: ProjectDraft) {
  return {
    name: d.name.trim(),
    repoPath: d.repoPath.trim(),
    projectTypes: d.projectTypes,
    description: d.description,
    requirementsPath: d.requirementsPath.trim() || DEFAULT_REQUIREMENTS_PATH,
    defaultPresetId: d.defaultPresetId,
    concurrencyLimit: parseConcurrency(d.concurrencyLimit) ?? null,
    devices: parseDevices(d.devices),
    color: d.color,
  };
}

export function validateDraft(d: PresetDraft): string | null {
  if (!d.name.trim()) return "请填写预设名称";
  if (!d.provider.trim()) return "请选择 agent（provider）";
  if (!d.model.trim()) return "请选择模型";
  return null;
}

// --- requirements document / manual triggers -------------------------------------------------

export interface RequirementsSaveResult {
  committed: boolean;
  commit: string | null;
  created: boolean;
}

/** One-line outcome of a requirements save for the panel. */
export function requirementsSaveMessage(r: RequirementsSaveResult): string {
  const created = r.created ? "已新建文件，" : "";
  return r.committed && r.commit
    ? `${created}已保存并提交（${r.commit.slice(0, 8)}）`
    : `${created}已保存，内容没有变化，未产生提交`;
}
