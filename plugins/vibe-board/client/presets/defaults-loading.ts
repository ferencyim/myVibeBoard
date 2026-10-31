/** Bound each attempt so a stalled RPC cannot leave the settings page loading forever. */
export function withDefaultsTimeout<T>(request: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("加载任务角色超时，请重试")), 15_000);
    Promise.resolve().then(request).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function defaultsLoadingState(
  defaults: { error: unknown; isPending: boolean },
  presets: { error: unknown; isPending: boolean },
): { status: "error"; error: unknown } | { status: "loading" | "ready" } {
  const error = defaults.error ?? presets.error;
  if (error) return { status: "error", error };
  if (defaults.isPending || presets.isPending) return { status: "loading" };
  return { status: "ready" };
}
