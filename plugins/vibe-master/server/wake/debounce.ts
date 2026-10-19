// Per-key trailing debounce: every touch restarts the quiet period; the key fires once it ends.

import type { Clock } from "../clock";

export interface Debouncer<K> {
  /** (Re)start the quiet period for `key`. `delayMs` overrides the default (0 = fire now). */
  touch(key: K, delayMs?: number): void;
  cancel(key: K): void;
  pending(): Array<{ key: K; dueAt: number }>;
  dispose(): void;
}

export function createDebouncer<K>(
  clock: Clock,
  defaultDelayMs: () => number,
  onFire: (key: K) => void,
): Debouncer<K> {
  const timers = new Map<K, { cancel: () => void; dueAt: number }>();

  function cancel(key: K): void {
    timers.get(key)?.cancel();
    timers.delete(key);
  }

  return {
    touch(key, delayMs) {
      cancel(key);
      const delay = delayMs ?? defaultDelayMs();
      const entry = {
        dueAt: clock.now() + delay,
        cancel: clock.setTimeout(() => {
          timers.delete(key);
          onFire(key);
        }, delay),
      };
      timers.set(key, entry);
    },
    cancel,
    pending: () => [...timers].map(([key, t]) => ({ key, dueAt: t.dueAt })),
    dispose() {
      for (const key of [...timers.keys()]) cancel(key);
    },
  };
}
