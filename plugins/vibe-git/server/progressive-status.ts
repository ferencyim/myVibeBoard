import { emptyGit } from "./git";
import type { Status } from "../shared/rpc";

type Loader = {
  fast(workspaceId: string): Promise<Status>;
  complete(cwd: string, force: boolean): Promise<Status>;
  snapshot?(status: Status): Status;
};

/** Return current-worktree data immediately and refresh the expensive sections in the background. */
export function createProgressiveStatus(loader: Loader, timeoutMs = 2400) {
  const entries = new Map<string, {
    fast?: Status; at: number; fastPending?: Promise<Status>;
    complete?: Status; pending?: Promise<void>; forcePending: boolean; lastComplete: number; completeError?: string;
  }>();
  let closed = false;
  function refresh(entry: NonNullable<ReturnType<typeof entries.get>>, cwd: string, force: boolean) {
    if (entry.pending) {
      entry.forcePending ||= force;
      return;
    }
    entry.lastComplete = Date.now();
    entry.pending = loader.complete(cwd, force).then((value) => {
      if (!closed) {
        if (value.git.status === "ok") { entry.complete = value; entry.completeError = undefined; }
        else entry.completeError = value.git.error ?? "读取 worktree 信息失败，请重试";
      }
    }).catch((error: unknown) => {
      if (!closed) entry.completeError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      entry.pending = undefined;
      if (!closed && entry.forcePending) {
        entry.forcePending = false;
        refresh(entry, cwd, true);
      }
    });
  }
  return {
    async get(key: string, force = false): Promise<Status> {
      let entry = entries.get(key);
      if (!entry) {
        entry = { at: 0, forcePending: false, lastComplete: 0 };
        entries.set(key, entry);
      }
      let timedOut = false;
      if (force || !entry.fast || Date.now() - entry.at >= 10000) {
        if (!entry.fastPending) {
          const target = entry;
          target.fastPending = loader.fast(key).catch((): Status => ({
            git: { ...emptyGit("", "error"), error: "读取 Git 状态失败，请重试" },
            build: { status: "dashboard_down", pipelines: [] },
            release: { status: "dashboard_down", products: [] },
          })).then((value) => {
            if (!closed) {
              target.fast = value;
              target.at = Date.now();
              if (timedOut && value.git.status === "ok") refresh(target, value.git.workspacePath, force);
            }
            return value;
          }).finally(() => { target.fastPending = undefined; });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
        const result = await Promise.race([entry.fastPending, timeout]);
        if (timer) clearTimeout(timer);
        timedOut = result === null;
      }
      const fast = entry.fast ?? {
        git: { ...emptyGit("", "error"), error: "读取 Git 状态超时，请重试" },
        build: { status: "dashboard_down" as const, pipelines: [] },
        release: { status: "dashboard_down" as const, products: [] },
      };
      const complete = entry.complete && (loader.snapshot?.(entry.complete) ?? entry.complete);
      if (fast.git.status === "ok" && (force || !complete || (!complete.git.scanning && Date.now() - entry.lastComplete >= 10000))) {
        refresh(entry, fast.git.workspacePath, force);
      }
      if (!complete) return entry.completeError ? { ...fast, git: { ...fast.git, scanning: false, scanError: entry.completeError } } : fast;
      if (complete.git.status !== "ok") return { ...fast, git: { ...fast.git, scanning: false, scanError: "读取 worktree 信息失败，请重试" } };
      if (fast.git.status !== "ok") return complete;
      if (complete.git.workspacePath !== fast.git.workspacePath) return fast;
      return {
        ...complete,
        git: {
          ...complete.git,
          scanError: entry.completeError ?? complete.git.scanError,
          workspacePath: fast.git.workspacePath,
          branch: fast.git.branch, headSha: fast.git.headSha, headSubject: fast.git.headSubject,
          upstream: fast.git.upstream, changes: fast.git.changes, commits: fast.git.commits,
          worktrees: complete.git.worktrees.map((w) => w.current ? { ...w, changes: fast.git.changes } : w),
        },
      };
    },
    clear() { closed = true; entries.clear(); },
  };
}
