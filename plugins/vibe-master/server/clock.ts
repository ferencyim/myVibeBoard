// Injectable time source so debounce, quota checks and retries are testable without real waits.

export interface Clock {
  now(): number;
  /** Schedule `fn`; the returned function cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearTimeout(timer);
  },
};
