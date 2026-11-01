import type { ModelGroup } from "@getpaseo/protocol/messages";

export function sortModelGroupEntries(groups: ModelGroup[]): ModelGroup[] {
  return groups.map((group) => ({
    ...group,
    entries: [...group.entries].sort((a, b) => a.order - b.order),
  }));
}
