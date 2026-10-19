// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Minimal Hybrid Logical Clock value format, shared by every writer of syncable rows.
// The merge/receive algorithm and fuzz tests belong to WP-13 (plugins/vibe-shared/sync);
// here we only fix the wire format and the local "tick" so the command layer can stamp rows.
//
// Format: "<wall ms as 12 hex>-<counter as 4 hex>-<node id>". Fixed width, so plain string
// comparison orders HLCs correctly (wall, then counter, then node as a deterministic tiebreak).

export type Hlc = string;

export interface HlcParts {
  wall: number;
  counter: number;
  node: string;
}

const HLC_PATTERN = /^([0-9a-f]{12})-([0-9a-f]{4})-(.+)$/;
export const MAX_HLC_COUNTER = 0xffff;

export function formatHlc(parts: HlcParts): Hlc {
  return `${parts.wall.toString(16).padStart(12, "0")}-${parts.counter.toString(16).padStart(4, "0")}-${parts.node}`;
}

export function parseHlc(hlc: Hlc): HlcParts {
  const m = HLC_PATTERN.exec(hlc);
  if (!m) throw new Error(`Invalid HLC: ${hlc}`);
  return {
    wall: parseInt(m[1] as string, 16),
    counter: parseInt(m[2] as string, 16),
    node: m[3] as string,
  };
}

export function isHlc(value: string): boolean {
  return HLC_PATTERN.test(value);
}

/** Total order on HLC strings. The empty string (never stamped) sorts before everything. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Local event: the next HLC after `prev` at physical time `nowMs` for `node`. Always > prev. */
export function tickHlc(prev: Hlc | null | undefined, nowMs: number, node: string): Hlc {
  if (!prev) return formatHlc({ wall: nowMs, counter: 0, node });
  const p = parseHlc(prev);
  if (nowMs > p.wall) return formatHlc({ wall: nowMs, counter: 0, node });
  if (p.counter >= MAX_HLC_COUNTER) return formatHlc({ wall: p.wall + 1, counter: 0, node });
  return formatHlc({ wall: p.wall, counter: p.counter + 1, node });
}
