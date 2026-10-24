// Maintenance planning model selection; permissions belong to the read-only task launcher.

import {
  selectAgent,
  presetModels,
  withPresetModel,
  type AgentProfile,
  type MaintenanceRule,
  type Preset,
  type Project,
} from "./vibe/contract";

export interface ResolvedAgent {
  provider: string;
  /** `provider/model` as the SDK expects it. */
  spec: string;
  thinkingOptionId?: string;
  source: string;
  preset?: Preset;
}

export interface AgentResolveDeps {
  presets: () => Preset[];
  defaultAgent: () => string;
}

const providerOf = (spec: string) => (spec.split("/")[0] ?? spec).toLowerCase();

function presetSpec(preset: Pick<Preset, "provider" | "model">): string {
  return preset.model.startsWith(`${preset.provider}/`)
    ? preset.model
    : `${preset.provider}/${preset.model}`;
}

function fromPreset(preset: Preset, source: string): ResolvedAgent {
  return {
    provider: preset.provider.toLowerCase(),
    spec: presetSpec(preset),
    ...(preset.thinking && preset.thinking !== "default"
      ? { thinkingOptionId: preset.thinking }
      : {}),
    source,
    preset,
  };
}

export function resolveAgentCandidates(
  rule: Pick<MaintenanceRule, "agent" | "name">,
  project: Project,
  deps: AgentResolveDeps,
): ResolvedAgent[] {
  const resolved = resolveAgent(rule, project, deps);
  return resolved.preset
    ? presetModels(resolved.preset).map((model) =>
        fromPreset(withPresetModel(resolved.preset!, model), resolved.source),
      )
    : [resolved];
}

function tierOf(preset: Pick<Preset, "model" | "thinking">): 1 | 2 | 3 {
  const name = `${preset.model} ${preset.thinking}`.toLowerCase();
  if (/(opus|fable|xhigh|max|ultra|gpt-5(?!.*mini)|o3|pro\b)/.test(name)) return 3;
  if (/(haiku|mini|flash|lite|nano)/.test(name)) return 1;
  return 2;
}

function profileOf(preset: Preset): AgentProfile {
  return {
    id: preset.id,
    provider: preset.provider.toLowerCase(),
    tier: tierOf(preset),
    strengths: preset.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
    presetId: preset.id,
  };
}

/** Resolves an explicit `agent` value: preset name/id, `provider/model`, or a bare provider. */
function fromText(text: string, presets: Preset[], project: Project): ResolvedAgent {
  const wanted = text.trim().toLowerCase();
  const named = presets.find((p) => p.id === text.trim() || p.name.toLowerCase() === wanted);
  if (named) return fromPreset(named, `preset ${named.name}`);
  if (wanted.includes("/")) {
    const same = presets.find((p) => presetSpec(p).toLowerCase() === wanted);
    if (same) return fromPreset(same, `preset ${same.name}`);
    return {
      provider: providerOf(wanted),
      spec: text.trim(),
      source: "rule",
    };
  }
  // Bare provider ("codex"): borrow the model of a preset for that provider.
  const ofProvider = presets.filter((p) => p.provider.toLowerCase() === wanted);
  const chosen = ofProvider.find((p) => p.id === project.defaultPresets.worker) ?? ofProvider[0];
  if (chosen) return fromPreset(chosen, `preset ${chosen.name}`);
  throw new Error(
    `维护规则模型「${text}」不是预设或 provider/model；请指定预设名称或「${text}/<model>」`,
  );
}

export function resolveAgent(
  rule: Pick<MaintenanceRule, "agent" | "name">,
  project: Project,
  deps: AgentResolveDeps,
): ResolvedAgent {
  const presets = deps.presets();
  if (rule.agent?.trim()) return fromText(rule.agent, presets, project);

  if (presets.length > 0) {
    const selection = selectAgent(
      presets.map(profileOf),
      { tags: ["chore", "maintenance"], size: "S", priority: "low" },
      { quota: {} },
    );
    const picked = presets.find((p) => p.id === selection.agentId);
    if (picked) return fromPreset(picked, `selected: ${selection.reason}`);
    const fallback = presets.find((p) => p.id === project.defaultPresets.worker);
    if (fallback) return fromPreset(fallback, "project default preset");
  }
  return fromText(deps.defaultAgent(), presets, project);
}
