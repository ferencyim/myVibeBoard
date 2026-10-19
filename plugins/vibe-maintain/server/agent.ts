// Which agent runs a maintenance fix, and with which permission mode.
//
// A worker started by a rule runs unattended, so a mode that asks for approval would stall on its
// first shell command. Resolution order: the rule's `agent` (preset name/id or `provider/model`),
// else the shared `selectAgent` ranking over the board presets, else the project's default preset,
// else the `defaultAgent` setting. The permission mode comes from the chosen preset; without a
// preset it is the provider's "accept edits" style mode, never full access.

import {
  selectAgent,
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
  source: string;
}

export interface AgentResolveDeps {
  presets: () => Preset[];
  defaultAgent: () => string;
}

/** Unattended "accept edits" style mode per provider (codex routes approvals to the auto reviewer). */
const UNATTENDED_MODE: Record<string, string> = { claude: "acceptEdits", codex: "auto-review" };

export function modeFor(provider: string, mode: Preset["permissionMode"] | null): string | undefined {
  const p = provider.toLowerCase();
  if (mode === "full") return p === "claude" ? "bypassPermissions" : p === "codex" ? "full-access" : "auto";
  if (mode === "auto") return "auto";
  return UNATTENDED_MODE[p];
}

const providerOf = (spec: string) => (spec.split("/")[0] ?? spec).toLowerCase();

function presetSpec(preset: Pick<Preset, "provider" | "model">): string {
  return preset.model.startsWith(`${preset.provider}/`) ? preset.model : `${preset.provider}/${preset.model}`;
}

function fromPreset(preset: Preset, source: string): ResolvedAgent {
  return {
    provider: preset.provider.toLowerCase(),
    spec: presetSpec(preset),
    modeId: modeFor(preset.provider, preset.permissionMode),
    source,
  };
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
function fromText(text: string, presets: Preset[], project: Project): ResolvedAgent {
  const wanted = text.trim().toLowerCase();
  const named = presets.find((p) => p.id === text.trim() || p.name.toLowerCase() === wanted);
  if (named) return fromPreset(named, `preset ${named.name}`);
  if (wanted.includes("/")) {
    const same = presets.find((p) => presetSpec(p).toLowerCase() === wanted);
    if (same) return fromPreset(same, `preset ${same.name}`);
    return { provider: providerOf(wanted), spec: text.trim(), modeId: modeFor(providerOf(wanted), null), source: "rule" };
  }
  // Bare provider ("codex"): borrow the model of a preset for that provider.
  const ofProvider = presets.filter((p) => p.provider.toLowerCase() === wanted);
  const chosen = ofProvider.find((p) => p.id === project.defaultPresetId) ?? ofProvider[0];
  if (chosen) return fromPreset(chosen, `preset ${chosen.name}`);
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
  if (rule.agent?.trim()) return fromText(rule.agent, presets, project);

  if (presets.length > 0) {
    const selection = selectAgent(
      presets.map(profileOf),
      { tags: ["chore", "maintenance"], size: "S", priority: "low" },
      { quota: {} },
    );
    const picked = presets.find((p) => p.id === selection.agentId);
    if (picked) return fromPreset(picked, `selected: ${selection.reason}`);
    const fallback = presets.find((p) => p.id === project.defaultPresetId);
    if (fallback) return fromPreset(fallback, "project default preset");
  }
  return fromText(deps.defaultAgent(), presets, project);
}
