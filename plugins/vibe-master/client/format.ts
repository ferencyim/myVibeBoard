// Pure helpers for the master screen (no React): what the owner can switch to, and how to label it.

import type { MasterTarget, ProviderInfo } from "../shared/rpc";

export interface SwitchChoice {
  key: string;
  label: string;
  detail: string;
  level: ProviderInfo["level"];
  request: { provider: string; model?: string; thinking?: string };
  active: boolean;
}

export const targetLabel = (t: MasterTarget | null): string =>
  t ? `${t.provider} / ${t.model}${t.thinking ? ` (${t.thinking})` : ""}` : "not resolved yet";

export function quotaLabel(p: Pick<ProviderInfo, "remainingPct" | "level">): string {
  if (p.remainingPct === null) return "quota unknown";
  return `${p.remainingPct}% left${p.level === "ok" ? "" : ` - ${p.level}`}`;
}

/**
 * One choice per provider model (default reasoning), plus one "max reasoning" choice for models
 * that offer thinking levels. Claude's Opus and the default models come first.
 */
export function switchChoices(providers: ProviderInfo[], active: MasterTarget | null): SwitchChoice[] {
  const out: SwitchChoice[] = [];
  for (const p of providers) {
    const models = [...p.models].sort(
      (a, b) =>
        Number(/opus/i.test(b.id)) - Number(/opus/i.test(a.id)) ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.id.localeCompare(b.id),
    );
    for (const m of models.slice(0, 3)) {
      const isActive = active?.provider === p.id && active.model === m.id;
      out.push({
        key: `${p.id}:${m.id}`,
        label: `${p.label} / ${m.label}`,
        detail: quotaLabel(p),
        level: p.level,
        request: { provider: p.id, model: m.id },
        active: isActive && !active?.thinking,
      });
      if (m.thinking.length > 1) {
        out.push({
          key: `${p.id}:${m.id}:max`,
          label: `${p.label} / ${m.label} - highest reasoning`,
          detail: quotaLabel(p),
          level: p.level,
          request: { provider: p.id, model: m.id, thinking: "max" },
          active: isActive && !!active?.thinking,
        });
      }
    }
  }
  return out;
}
