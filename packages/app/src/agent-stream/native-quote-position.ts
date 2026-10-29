/** FlatList is inverted: the header's layout origin is the bottom edge. */
export function nativeQuoteOffset(y: number, height: number, viewportHeight: number): number {
  return Math.max(0, y + height - viewportHeight / 2);
}
