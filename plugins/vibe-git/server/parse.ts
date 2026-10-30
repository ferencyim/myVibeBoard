import type { Changes } from "../shared/rpc";

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function matchesRepo(paths: unknown[], mainPath: string): boolean {
  return paths.some((p) => typeof p === "string" && normalizePath(p) === normalizePath(mainPath));
}

export function parseStatus(raw: string): Changes {
  const result = { staged: 0, unstaged: 0, untracked: 0, total: 0 };
  for (const line of raw.split("\n")) {
    if (line.length < 3) continue;
    result.total++;
    if (line.startsWith("??")) {
      result.untracked++;
    } else {
      if (line[0] !== " ") result.staged++;
      if (line[1] !== " ") result.unstaged++;
    }
  }
  return result;
}

export function parseCounts(raw: string): { ahead: number; behind: number } | null {
  const match = raw.trim().match(/^(\d+)\s+(\d+)$/);
  return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : null;
}

export function parseWorktrees(raw: string): {
  path: string;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
}[] {
  return raw.trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const lines = block.split(/\r?\n/);
    return {
      path: lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "",
      branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null,
      detached: lines.includes("detached"),
      prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
    };
  }).filter((w) => w.path);
}

export type DashboardResult = {
  status: "ok" | "dashboard_down" | "not_configured" | "error";
  values: Record<string, unknown>[];
};

export function selectDashboard(
  data: unknown,
  key: "pipelines" | "products",
  mainPath: string | null,
  failed = false,
): DashboardResult {
  if (failed) return { status: "dashboard_down", values: [] };
  if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>)[key])) {
    return { status: "error", values: [] };
  }
  const values = ((data as Record<string, unknown>)[key] as unknown[])
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .filter((v) => mainPath !== null && matchesRepo([v.repo, v.sourceRepo, v.buildRepo], mainPath));
  return { status: values.length ? "ok" : "not_configured", values };
}
