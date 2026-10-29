import type { ProviderSelectionModelRow } from "@/provider-selection/provider-selection";

export interface PickerModelItem {
  key: string;
  provider: string;
  modelId: string;
  name: string;
  /** Text before the first "/" in the label; null when the label has no service prefix. */
  service: string | null;
  isDefault: boolean;
}

export interface PickerModelGroup {
  service: string | null;
  items: PickerModelItem[];
}

/** Leading whitespace, colons and dashes are noise; an empty result falls back to the id. */
export function cleanModelName(label: string, id: string): string {
  const cleaned = label.replace(/^[\s:\-–—]+/, "").trim();
  return cleaned.length > 0 ? cleaned : id;
}

export function toModelItem(row: ProviderSelectionModelRow): PickerModelItem {
  const label = cleanModelName(row.modelLabel, row.modelId);
  const slash = label.indexOf("/");
  const hasService = slash > 0 && slash < label.length - 1;
  return {
    key: row.favoriteKey,
    provider: row.provider,
    modelId: row.modelId,
    name: hasService ? label.slice(slash + 1).trim() : label,
    service: hasService ? label.slice(0, slash).trim() : null,
    isDefault: Boolean(row.isDefault),
  };
}

/** Groups by service in first-seen order, so the upstream ordering survives. */
export function groupModelItems(items: PickerModelItem[]): PickerModelGroup[] {
  const groups: PickerModelGroup[] = [];
  const byService = new Map<string | null, PickerModelGroup>();
  for (const item of items) {
    let group = byService.get(item.service);
    if (!group) {
      group = { service: item.service, items: [] };
      byService.set(item.service, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** Case-insensitive substring match over "service name"; empty groups drop out. */
export function filterModelGroups(groups: PickerModelGroup[], query: string): PickerModelGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  const result: PickerModelGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) =>
      `${item.service ?? ""} ${item.name}`.toLowerCase().includes(needle),
    );
    if (items.length > 0) result.push({ service: group.service, items });
  }
  return result;
}

export function flattenModelGroups(groups: PickerModelGroup[]): PickerModelItem[] {
  return groups.flatMap((group) => group.items);
}

/** Up/down move with wrap-around; -1 means nothing is highlighted yet. */
export function moveHighlight(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export type EffortControlKind = "segmented" | "select";

/** At most five options with at most 26 label characters in total fit a segmented control. */
export function resolveEffortControlKind(labels: string[]): EffortControlKind {
  const total = labels.reduce((sum, label) => sum + label.length, 0);
  return labels.length <= 5 && total <= 26 ? "segmented" : "select";
}
