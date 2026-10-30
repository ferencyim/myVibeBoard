/** Coalesces requests by key and keeps successful results for a short interval. */
export function createSingleFlight<T>(ttlMs: number, load: (key: string) => Promise<T>) {
  const cache = new Map<string, { value: T; at: number }>();
  const pending = new Map<string, Promise<T>>();
  let closed = false;
  return {
    get(key: string, force = false): Promise<T> {
      const active = pending.get(key);
      if (active) return active;
      const cached = cache.get(key);
      if (!force && cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      const request = load(key)
        .then((value) => {
          if (!closed) cache.set(key, { value, at: Date.now() });
          return value;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
    clear() {
      closed = true;
      cache.clear();
      pending.clear();
    },
  };
}
