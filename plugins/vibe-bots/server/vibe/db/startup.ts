// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
/** Run optional startup work after the contribution and ready microtasks have returned. */
export function deferStartup(
  initialize: () => void | Promise<void>,
  onError: (error: unknown) => void,
) {
  let cancelled = false;
  let initialization: Promise<void> | null = null;
  let cancel!: (error: Error) => void;
  let timer!: ReturnType<typeof setTimeout>;
  const ready = new Promise<void>((resolve, reject) => {
    cancel = reject;
    timer = setTimeout(() => {
      initialization = Promise.resolve().then(initialize);
      void initialization.then(resolve, reject);
    }, 0);
  });
  // Retain the rejection for dependent requests, and report failures without a request too.
  void ready.catch((error) => {
    if (!cancelled) onError(error);
  });
  return {
    ready,
    wrap<A extends unknown[], R>(handler: (...args: A) => R) {
      return async (...args: A): Promise<Awaited<R>> => {
        await ready;
        if (cancelled) throw new Error("插件已停止");
        return await handler(...args);
      };
    },
    async close() {
      cancelled = true;
      clearTimeout(timer);
      cancel(new Error("插件已停止"));
      // The caller may close its database only after already-started recovery has settled.
      await initialization?.catch(() => undefined);
    },
  };
}
