export function sortPageRailItems<T extends { key: string; order: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}
