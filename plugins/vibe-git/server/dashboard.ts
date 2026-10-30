import type { Status } from "../shared/rpc";
import { selectDashboard } from "./parse";
import { sourceRelation } from "./git";

const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

const summary = (v: unknown): string | null => {
  const o = object(v);
  const text = typeof v === "string" ? v : str(o.status) ?? str(o.state) ?? str(o.message) ?? str(o.reason);
  return text?.split(/\r?\n/, 1)[0].slice(0, 300)
    .replace(/\bBearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/(token|authorization|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?[^\s,"']+/gi, "$1=[已隐藏]")
    ?? null;
};

const version = (v: unknown) => {
  if (!v || typeof v !== "object") return null;
  const o = object(v);
  return {
    displayVersion: str(o.displayVersion),
    build: str(o.build),
    stateChangedAt: str(o.stateChangedAt),
  };
};

async function fetchSection(endpoint: string, key: "pipelines" | "products", mainPath: string | null) {
  try {
    const base = process.env.VIBE_CI_DASHBOARD_URL || "http://127.0.0.1:43173";
    const response = await fetch(`${base.replace(/\/$/, "")}${endpoint}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { status: "error" as const, values: [] };
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { status: "error" as const, values: [] };
    }
    return selectDashboard(data, key, mainPath);
  } catch {
    return selectDashboard(null, key, mainPath, true);
  }
}

export async function buildStatus(cwd: string, mainPath: string | null): Promise<Status["build"]> {
  const result = await fetchSection("/api/status", "pipelines", mainPath);
  const pipelines = await Promise.all(result.values.map(async (p) => {
    const sourceSha = str(p.sourceSha);
    return {
      repo: str(p.repo) ?? "",
      project: str(p.project),
      status: str(p.status),
      buildStatus: str(p.buildStatus),
      failureReason: summary(p.failureReason),
      clientStatuses: (Array.isArray(p.clientStatuses) ? p.clientStatuses : []).map((v) => {
        const c = object(v);
        return {
          client: str(c.client) ?? "",
          buildStatus: str(c.buildStatus),
          uploadStatus: str(c.uploadStatus),
          publishStatus: str(c.publishStatus),
        };
      }),
      upload: summary(p.upload),
      publish: summary(p.publish),
      startedAt: str(p.startedAt),
      finishedAt: str(p.finishedAt),
      sourceSha,
      shaRelation: await sourceRelation(cwd, sourceSha),
    };
  }));
  return { status: result.status, pipelines };
}

export async function releaseStatus(mainPath: string | null): Promise<Status["release"]> {
  const result = await fetchSection("/api/release/overview", "products", mainPath);
  return {
    status: result.status,
    products: result.values.map((p) => ({
      id: str(p.id) ?? "",
      name: str(p.name) ?? "",
      repo: str(p.repo) ?? "",
      status: str(p.status) ?? "error",
      stale: p.stale === true,
      fetchedAt: str(p.fetchedAt),
      items: (Array.isArray(p.items) ? p.items : []).map((v) => {
        const i = object(v);
        return {
          targetKey: str(i.targetKey) ?? "",
          platform: str(i.platform) ?? "",
          channel: str(i.channel) ?? "",
          released: version(i.released),
          testing: version(i.testing),
          rollingOut: version(i.rollingOut),
          unreleasedCommitCount: typeof i.unreleasedCommitCount === "number" ? i.unreleasedCommitCount : null,
          lastGateFailure: summary(i.lastGateFailure),
          storeSubmission: summary(i.storeSubmission),
        };
      }),
    })),
  };
}
