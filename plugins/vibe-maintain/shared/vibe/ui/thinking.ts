// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Display names of thinking levels, shared by the preset form and the master-agent settings page.

export interface ThinkingOptionLike {
  id: string;
  label?: string;
}

const THINKING_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极高",
};

/**
 * A Chinese label from the provider wins. Otherwise a well-known level id gets its Chinese name,
 * even when the provider's English label differs from the id ("Extra High" for xhigh), so one
 * picker never mixes 低/中/高 with English labels. An unknown id shows the provider's label,
 * else the id.
 */
export function thinkingLabel(option: ThinkingOptionLike): string {
  const label = option.label?.trim();
  if (label && /[㐀-鿿]/.test(label)) return label;
  return THINKING_LABELS[option.id.toLowerCase()] ?? (label || option.id);
}
