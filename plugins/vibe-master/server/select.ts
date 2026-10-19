// Sub-agent selection port (IMPLEMENTATION-PLAN M4). The ranking itself is the scheduler's pure
// `selectAgent` (vibe-shared/contract/select.ts, shared by both plugins); this adapter turns the
// board's presets into capability-table profiles and the result back into a preset choice.
// `AgentSelector` stays a function type so tests and other policies can replace it.

import {
  selectAgent,
  type AgentProfile,
  type CardPriority,
  type Preset,
  type ProviderQuota,
} from "./vibe/contract";
import type { Size } from "./assess/schema";

export interface SelectInput {
  priority: CardPriority;
  size?: Size;
  tags: string[];
  platform?: string;
  presets: Preset[];
  quota: Record<string, ProviderQuota>;
  /** Preset the owner picked on the card; wins when its provider still has quota. */
  preselectedPresetId?: string | null;
  /** Per preset id: tag -> score in [-1, 1] (parsed from workers/<agent>/MEMORY.md). */
  history?: Record<string, Record<string, number>>;
}

export interface SelectResult {
  presetId: string | null;
  presetName: string | null;
  provider: string | null;
  reason: string;
  /** Set when nothing may start now (every candidate is out of quota). */
  wait: string | null;
}

export type AgentSelector = (input: SelectInput) => SelectResult;

/** 1 = cheap/fast, 3 = strongest, inferred from the model name. */
export function presetTier(preset: Pick<Preset, "model" | "thinking">): 1 | 2 | 3 {
  const name = `${preset.model} ${preset.thinking}`.toLowerCase();
  if (/(opus|xhigh|max|ultra|sol\b|gpt-5(?!.*mini)|o3|pro\b)/.test(name)) return 3;
  if (/(haiku|mini|flash|lite|nano|luna)/.test(name)) return 1;
  return 2;
}

function profileOf(preset: Preset): AgentProfile {
  const words = preset.name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return {
    id: preset.id,
    provider: preset.provider.toLowerCase(),
    tier: presetTier(preset),
    strengths: [...words, ...(preset.runtimeEnv ? [preset.runtimeEnv.toLowerCase()] : [])],
    presetId: preset.id,
  };
}

export const defaultSelector: AgentSelector = (input) => {
  const none = (reason: string, wait: string | null = null): SelectResult => ({
    presetId: null,
    presetName: null,
    provider: null,
    reason,
    wait,
  });
  if (input.presets.length === 0) return none("no presets configured");
  const profiles = input.presets.map(profileOf);

  // The owner's pick wins unless its provider is out of quota.
  const pre = input.preselectedPresetId
    ? input.presets.find((p) => p.id === input.preselectedPresetId)
    : undefined;
  const preExhausted = pre && input.quota[pre.provider.toLowerCase()]?.level === "exhausted";
  const selection = selectAgent(
    profiles,
    {
      tags: input.tags,
      size: input.size,
      platform: input.platform,
      priority: input.priority,
      preselected: pre && !preExhausted ? pre.id : null,
    },
    { quota: input.quota, history: input.history },
  );

  const chosen = selection.agentId
    ? input.presets.find((p) => p.id === selection.agentId)
    : undefined;
  if (!chosen) return none(selection.reason, selection.wait?.reason ?? null);
  return {
    presetId: chosen.id,
    presetName: chosen.name,
    provider: chosen.provider,
    reason: selection.reason,
    wait: null,
  };
};
