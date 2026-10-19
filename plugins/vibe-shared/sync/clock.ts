// Hybrid logical clock: local tick + receive/merge with a drift limit.
// Wire format and tickHlc live in contract/hlc.ts.

import { MAX_HLC_COUNTER, formatHlc, parseHlc, tickHlc, type Hlc } from "../contract/hlc";

/** Default tolerated distance between a remote wall clock and ours (24h; covers +-1h drift easily). */
export const DEFAULT_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export class HlcDriftError extends Error {
  readonly code = "clock_drift";
  constructor(
    readonly remote: Hlc,
    readonly driftMs: number,
  ) {
    super(`HLC ${remote} is ${driftMs}ms ahead of the local clock`);
  }
}

/**
 * Standard HLC receive: the returned HLC is greater than both `prev` and `remote`.
 * Throws HlcDriftError when `remote` is more than `maxDriftMs` ahead of `nowMs`.
 */
export function receiveHlc(
  prev: Hlc | null | undefined,
  remote: Hlc,
  nowMs: number,
  node: string,
  maxDriftMs: number = DEFAULT_MAX_DRIFT_MS,
): Hlc {
  const r = parseHlc(remote);
  if (r.wall - nowMs > maxDriftMs) throw new HlcDriftError(remote, r.wall - nowMs);
  const p = prev ? parseHlc(prev) : null;
  const pw = p ? p.wall : 0;
  const wall = Math.max(nowMs, pw, r.wall);
  let counter = 0;
  if (p && wall === pw && wall === r.wall) counter = Math.max(p.counter, r.counter) + 1;
  else if (p && wall === pw) counter = p.counter + 1;
  else if (wall === r.wall) counter = r.counter + 1;
  if (counter > MAX_HLC_COUNTER) return formatHlc({ wall: wall + 1, counter: 0, node });
  return formatHlc({ wall, counter, node });
}

export interface HlcClockOptions {
  node: string;
  /** Physical clock in ms; injectable for tests. */
  now?: () => number;
  maxDriftMs?: number;
  /** Last issued HLC (persisted by the host), so ticks stay monotonic across restarts. */
  last?: Hlc | null;
  /** Called after every advance so the host can persist `last`. */
  onAdvance?: (hlc: Hlc) => void;
}

export class HlcClock {
  readonly node: string;
  readonly maxDriftMs: number;
  private last: Hlc | null;
  private offsetMs = 0;
  private readonly nowFn: () => number;
  private readonly onAdvance?: (hlc: Hlc) => void;

  constructor(opts: HlcClockOptions) {
    this.node = opts.node;
    this.nowFn = opts.now ?? Date.now;
    this.maxDriftMs = opts.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;
    this.last = opts.last ?? null;
    this.onAdvance = opts.onAdvance;
  }

  /** Physical time as this clock sees it (after any correction). */
  now(): number {
    return this.nowFn() + this.offsetMs;
  }

  get lastHlc(): Hlc | null {
    return this.last;
  }

  /** New HLC for a local event; strictly greater than everything issued/received so far. */
  tick(): Hlc {
    return this.advance(tickHlc(this.last, this.now(), this.node));
  }

  /** Merge a remote HLC (throws HlcDriftError when too far ahead); returns the new local HLC. */
  receive(remote: Hlc): Hlc {
    return this.advance(receiveHlc(this.last, remote, this.now(), this.node, this.maxDriftMs));
  }

  /**
   * The local wall clock is wrong: shift it so that now() == trueNowMs and forget the (possibly
   * future-dated) history. The caller must re-stamp not-yet-synced local writes.
   */
  correct(trueNowMs: number): void {
    this.offsetMs = trueNowMs - this.nowFn();
    this.last = null;
  }

  private advance(hlc: Hlc): Hlc {
    this.last = hlc;
    this.onAdvance?.(hlc);
    return hlc;
  }
}
