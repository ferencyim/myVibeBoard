import type { PaseoApi } from "@getpaseo/client";

/** Cache only completed successes; concurrent readers share the pending host request. */
export function cacheHostRead<T>(load: () => Promise<T>, ttlMs: number, now = Date.now) {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
    pending = Promise.resolve().then(load).then((value) => {
      cached = { value, expiresAt: now() + ttlMs };
      return value;
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

type ProjectList = Awaited<ReturnType<PaseoApi["projects"]["list"]>>;
const projectLists = new WeakMap<PaseoApi, () => Promise<ProjectList>>();

/** One cache per connected host API, shared by tabs, sidebar, settings and documents. */
export function listHostProjects(paseo: PaseoApi): Promise<ProjectList> {
  let read = projectLists.get(paseo);
  if (!read) {
    read = cacheHostRead(() => paseo.projects.list(), 30_000);
    projectLists.set(paseo, read);
  }
  return read();
}
