// Pure preset / usage helpers (WP-14). No React imports.

import {
  presetModels,
  plannerList,
  type ModelDefaults,
  type Preset,
  type PresetEnvironmentKind,
  type PresetPermissionMode,
} from "../../shared/vibe/contract";
import { thinkingLabel } from "../../shared/vibe/ui/thinking";

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

export type PresetModelDraft = Pick<Preset, "provider" | "model" | "thinking" | "permissionMode">;

export const EMPTY_MODEL_DRAFT: PresetModelDraft = {
  provider: "",
  model: "",
  thinking: "",
  permissionMode: "auto",
};

export interface PresetDraft {
  name: string;
  models: PresetModelDraft[];
  environmentKind: PresetEnvironmentKind;
  baseBranch: string;
  runtimeEnv: string;
  instructions: string;
  /** Ordered preset ids to continue on when an agent on this preset fails (quota, login, ...). */
  fallbackPresetIds: string[];
}

export const EMPTY_PRESET_DRAFT: PresetDraft = {
  name: "",
  models: [{ ...EMPTY_MODEL_DRAFT }],
  environmentKind: "new-worktree",
  baseBranch: "",
  runtimeEnv: "",
  instructions: "",
  fallbackPresetIds: [],
};

export function presetToDraft(p: Preset): PresetDraft {
  return {
    name: p.name,
    models: presetModels(p).map((model) => ({ ...model })),
    environmentKind: p.environmentKind,
    baseBranch: p.baseBranch ?? "",
    runtimeEnv: p.runtimeEnv ?? "",
    instructions: p.instructions,
    fallbackPresetIds: p.fallbackPresetIds ?? [],
  };
}

/** Move a candidate one place while keeping every model's settings together. */
export function movePresetModel(
  models: readonly PresetModelDraft[],
  index: number,
  direction: -1 | 1,
): PresetModelDraft[] {
  const target = index + direction;
  const next = [...models];
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Toggle `id` in the ordered chain: selecting appends (order = click order), selecting again removes. */
export function toggleFallback(chain: readonly string[], id: string): string[] {
  return chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id];
}

/** Draft -> RPC payload (blank optional strings become null). */
export function draftToPayload(d: PresetDraft) {
  const models = d.models.map((m) => ({
    ...m,
    provider: m.provider.trim(),
    model: m.model.trim(),
    thinking: m.thinking.trim(),
  }));
  return {
    name: d.name.trim(),
    ...models[0]!,
    models,
    environmentKind: d.environmentKind,
    baseBranch: d.baseBranch.trim() || null,
    runtimeEnv: d.runtimeEnv.trim() || null,
    instructions: d.instructions,
    fallbackPresetIds: d.fallbackPresetIds.length ? d.fallbackPresetIds : null,
    roleHints: [],
  };
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
  const choices = [DEFAULT_THINKING_OPTION, ...options.map((o) => ({ id: o.id, label: thinkingLabel(o) }))];
  if (current && !options.some((o) => o.id === current)) {
    choices.push({ id: current, label: `${thinkingLabel({ id: current })}（当前值）` });
  }
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

/** Sets one job of a defaults map; null removes it (follow the next level). */
export function setDefault(
  d: ModelDefaults,
  role: Exclude<keyof ModelDefaults, "planners">,
  presetId: string | null,
): ModelDefaults {
  const next = { ...d };
  if (presetId) next[role] = presetId;
  else delete next[role];
  return next;
}

/** The #2 方案 list of a defaults level (legacy planner + plan reviewer read as a list). */
export function plannersOf(d: ModelDefaults): string[] {
  return plannerList(d) ?? [];
}

/** Sets entry `index` of the #2 方案 list (index = length appends); null removes the entry and
 *  the later ones move up. An empty list removes the key (follow the next level). */
export function setPlanner(d: ModelDefaults, index: number, presetId: string | null): ModelDefaults {
  const list = plannersOf(d);
  if (presetId) list[index] = presetId;
  else list.splice(index, 1);
  const next = { ...d };
  delete next.planner;
  delete next.plan_reviewer;
  if (list.length) next.planners = list;
  else delete next.planners;
  return next;
}

export function validateDraft(d: PresetDraft): string | null {
  if (!d.name.trim()) return "请填写预设名称";
  if (!d.models.length) return "请至少添加一个候选模型";
  for (const [index, model] of d.models.entries()) {
    if (!model.provider.trim()) return `请选择第 ${index + 1} 个候选的 agent（provider）`;
    if (!model.model.trim()) return `请选择第 ${index + 1} 个候选的模型`;
  }
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
