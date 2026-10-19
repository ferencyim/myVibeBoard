// Pure preset / usage helpers (WP-14). No React imports.

import type {
  Preset,
  PresetEnvironmentKind,
  PresetPermissionMode,
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

export interface PresetDraft {
  name: string;
  provider: string;
  model: string;
  thinking: string;
  permissionMode: PresetPermissionMode;
  environmentKind: PresetEnvironmentKind;
  baseBranch: string;
  runtimeEnv: string;
  instructions: string;
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
  };
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
  };
}

export function validateDraft(d: PresetDraft): string | null {
  if (!d.name.trim()) return "请填写预设名称";
  if (!d.provider.trim()) return "请选择 agent（provider）";
  if (!d.model.trim()) return "请选择模型";
  return null;
}
