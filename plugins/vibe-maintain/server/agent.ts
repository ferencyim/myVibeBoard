// Which agent runs a maintenance fix, and with which permission mode.
//
// A worker started by a rule runs unattended, so a mode that asks for approval would stall on its
// first shell command. Resolution order: the rule's `agent` (preset name/id or `provider/model`),
// else the shared `selectAgent` ranking over the board presets, else the project's default preset,
// else the `defaultAgent` setting. The permission mode comes from the chosen preset; without a
// preset it is the provider's "accept edits" style mode, never full access.

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
  modeId?: string;
  thinkingOptionId?: string;
  source: string;
  preset?: Preset;
}

export interface AgentResolveDeps {
  presets: () => Preset[];
  defaultAgent: () => string;
  /** Unattended mode id per provider (setting); defaults to UNATTENDED_MODE. */
  unattendedModes?: () => Record<string, string>;
}

/** Unattended "accept edits" style mode per provider (codex routes approvals to the auto reviewer). */
export const UNATTENDED_MODE: Record<string, string> = { claude: "acceptEdits", codex: "auto-review" };

export function modeFor(
  provider: string,
  mode: Preset["permissionMode"] | null,
  unattended: Record<string, string> = UNATTENDED_MODE,
): string | undefined {
  const p = provider.toLowerCase();
  if (mode === "full") return p === "claude" ? "bypassPermissions" : p === "codex" ? "full-access" : "auto";
  if (mode === "auto") return "auto";
  return unattended[p];
}

const providerOf = (spec: string) => (spec.split("/")[0] ?? spec).toLowerCase();

function presetSpec(preset: Pick<Preset, "provider" | "model">): string {
  return preset.model.startsWith(`${preset.provider}/`) ? preset.model : `${preset.provider}/${preset.model}`;
}

function fromPreset(preset: Preset, source: string, unattended?: Record<string, string>): ResolvedAgent {
  return {
    provider: preset.provider.toLowerCase(),
    spec: presetSpec(preset),
    modeId: modeFor(preset.provider, preset.permissionMode, unattended),
    ...(preset.thinking && preset.thinking !== "default" ? { thinkingOptionId: preset.thinking } : {}),
    source,
    preset,
  };
}

export function resolveAgentCandidates(
  rule: Pick<MaintenanceRule, "agent" | "name">,
  project: Project,
  deps: AgentResolveDeps
): ResolvedAgent[] {
  const resolved = resolveAgent(rule, project, deps);
  return resolved.preset
    ? presetModels(resolved.preset).map((model) =>
        fromPreset(
          withPresetModel(resolved.preset!, model),
          resolved.source,
          deps.unattendedModes?.()
        )
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
    strengths: preset.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
    presetId: preset.id,
  };
}

/** Resolves an explicit `agent` value: preset name/id, `provider/model`, or a bare provider. */
function fromText(text: string, presets: Preset[], project: Project, unattended?: Record<string, string>): ResolvedAgent {
  const wanted = text.trim().toLowerCase();
  const named = presets.find((p) => p.id === text.trim() || p.name.toLowerCase() === wanted);
  if (named) return fromPreset(named, `preset ${named.name}`, unattended);
  if (wanted.includes("/")) {
    const same = presets.find((p) => presetSpec(p).toLowerCase() === wanted);
    if (same) return fromPreset(same, `preset ${same.name}`, unattended);
    return { provider: providerOf(wanted), spec: text.trim(), modeId: modeFor(providerOf(wanted), null, unattended), source: "rule" };
  }
  // Bare provider ("codex"): borrow the model of a preset for that provider.
  const ofProvider = presets.filter((p) => p.provider.toLowerCase() === wanted);
  const chosen = ofProvider.find((p) => p.id === project.defaultPresets.worker) ?? ofProvider[0];
  if (chosen) return fromPreset(chosen, `preset ${chosen.name}`, unattended);
  throw new Error(
    `Maintenance rule agent "${text}" is neither a preset nor provider/model; write a preset name or "${text}/<model>"`,
  );
}

export function resolveAgent(
  rule: Pick<MaintenanceRule, "agent" | "name">,
  project: Project,
  deps: AgentResolveDeps,
): ResolvedAgent {
  const presets = deps.presets();
  const unattended = deps.unattendedModes?.();
  if (rule.agent?.trim()) return fromText(rule.agent, presets, project, unattended);

  if (presets.length > 0) {
    const selection = selectAgent(
      presets.map(profileOf),
      { tags: ["chore", "maintenance"], size: "S", priority: "low" },
      { quota: {} },
    );
    const picked = presets.find((p) => p.id === selection.agentId);
    if (picked) return fromPreset(picked, `selected: ${selection.reason}`, unattended);
    const fallback = presets.find((p) => p.id === project.defaultPresets.worker);
    if (fallback) return fromPreset(fallback, "project default preset", unattended);
  }
  return fromText(deps.defaultAgent(), presets, project, unattended);
}
