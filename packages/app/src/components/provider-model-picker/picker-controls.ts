import type { AgentFeature, AgentMode } from "@getpaseo/protocol/agent-types";

/** Provider features the picker folds into its "fast" switch: Claude's toggle and Codex's speed tier. */
const FAST_TOGGLE_ID = "fast_mode";
const SPEED_TIER_ID = "service_tier";

export interface FastControl {
  featureId: string;
  value: boolean;
  /** The feature value that turns fast on and off. */
  on: unknown;
  off: unknown;
}

/** The feature ids the picker owns, so the composer does not draw them a second time. */
export function isPickerFeature(featureId: string): boolean {
  return featureId === FAST_TOGGLE_ID || featureId === SPEED_TIER_ID;
}

/** Claude has a `fast_mode` toggle; Codex a `service_tier` select whose non-default tier is fast. */
export function findFastControl(features: readonly AgentFeature[] | undefined): FastControl | null {
  for (const feature of features ?? []) {
    if (feature.id === FAST_TOGGLE_ID && feature.type === "toggle") {
      return { featureId: feature.id, value: feature.value === true, on: true, off: false };
    }
    if (feature.id === SPEED_TIER_ID && feature.type === "select") {
      const off = feature.options.find((option) => option.isDefault) ?? feature.options[0];
      const fastTiers = feature.options.filter((option) => option.id !== off?.id);
      const on = fastTiers.find((option) => option.id === "fast") ?? fastTiers[0];
      if (!on || !off) return null;
      return { featureId: feature.id, value: feature.value === on.id, on: on.id, off: off.id };
    }
  }
  return null;
}

const PERMISSION_LABELS: Record<string, Record<string, string>> = {
  claude: {
    plan: "计划",
    default: "每次询问",
    acceptEdits: "接受编辑",
    auto: "自动",
    bypassPermissions: "完全放行",
  },
  codex: { auto: "默认", "auto-review": "自动", "full-access": "完全访问" },
};

/** The "auto" tier of a provider: Claude's classifier mode, Codex's auto-reviewer. */
const AUTO_MODE_IDS: Record<string, string> = { claude: "auto", codex: "auto-review" };

export function autoModeId(provider: string): string | undefined {
  return AUTO_MODE_IDS[provider.toLowerCase()];
}

export function permissionLabel(provider: string, mode: Pick<AgentMode, "id" | "label">): string {
  return PERMISSION_LABELS[provider.toLowerCase()]?.[mode.id] ?? mode.label;
}

export function buildPermissionOptions(
  provider: string,
  modes: readonly Pick<AgentMode, "id" | "label">[],
): { id: string; label: string }[] {
  return modes.map((mode) => ({ id: mode.id, label: permissionLabel(provider, mode) }));
}
