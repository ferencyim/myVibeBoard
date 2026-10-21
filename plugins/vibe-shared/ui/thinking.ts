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
 * The provider's own label when it says more than the id (e.g. a Chinese or descriptive name);
 * otherwise the Chinese name of a well-known level. A label that only re-spells the id ("Low",
 * "low") counts as absent, so codex and claude levels read the same. Unknown ids show as is.
 */
export function thinkingLabel(option: ThinkingOptionLike): string {
  const label = option.label?.trim();
  if (label && label.toLowerCase() !== option.id.toLowerCase()) return label;
  return THINKING_LABELS[option.id.toLowerCase()] ?? label ?? option.id;
}
