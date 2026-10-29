// Pure helpers of the scheduler screen: the status RPC returns a loose record, so everything the
// screen shows goes through `parseStatus` (missing or malformed parts fall back to empty values).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

export interface SchedulerView {
  paused: boolean;
  briefing: string;
  tightItems: string[];
  hostErrors: string[];
  hosts: Array<{ name: string; cpu: number | null; availableBytes: number | null; totalBytes: number | null; load1: number | null; cores: number | null; error: string | null }>;
  running: { total: number; byProvider: Record<string, number> };
  /** Native task resource leases. */
  pending: Array<{ id: string; workspaceId: string; role: string; provider: string; port: number }>;
  /** Queued tasks that were not admitted, with the reason. */
  deferred: Array<{ workspaceId: string; reason: string }>;
  resources: { cpu: number; mem: number } | null;
  quota: Array<{
    provider: string;
    level: string;
    remainingPct: number | null;
    resetsAt: string | null;
  }>;
  pool: Array<{ name: string; kind: string; leased: boolean }>;
}

export function parseStatus(raw: unknown): SchedulerView {
  const o: Obj = isObj(raw) ? raw : {};
  const running = isObj(o.running) ? o.running : {};
  const byProvider = isObj(running.byProvider) ? running.byProvider : {};
  const resources = isObj(o.resources) ? o.resources : null;
  const pool = isObj(o.pool) && isObj(o.pool.devices) ? o.pool.devices : {};
  return {
    paused: o.paused === true,
    briefing: str(o.briefing, "资源：等待采样"),
    tightItems: (Array.isArray(o.tightItems) ? o.tightItems : []).filter(
      (v): v is string => typeof v === "string",
    ),
    hostErrors: (Array.isArray(o.hosts) ? o.hosts : [])
      .filter(isObj)
      .filter((h) => typeof h.error === "string")
      .map((h) => str(h.name) + "：" + str(h.error)),
    hosts: (Array.isArray(o.hosts) ? o.hosts : []).filter(isObj).map((h) => ({
      name: str(h.name),
      cpu: typeof h.cpu === "number" && Number.isFinite(h.cpu) ? h.cpu : null,
      availableBytes: typeof h.availableBytes === "number" && Number.isFinite(h.availableBytes) ? h.availableBytes : null,
      totalBytes: typeof h.totalBytes === "number" && Number.isFinite(h.totalBytes) ? h.totalBytes : null,
      load1: typeof h.load1 === "number" && Number.isFinite(h.load1) ? h.load1 : null,
      cores: typeof h.cores === "number" && Number.isFinite(h.cores) ? h.cores : null,
      error: typeof h.error === "string" ? h.error : null,
    })),
    running: {
      total: num(running.total),
      byProvider: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, num(v)])),
    },
    pending: (Array.isArray(o.pending) ? o.pending : []).filter(isObj).map((a) => ({
      id: str(a.id),
      workspaceId: str(a.workspaceId),
      role: str(a.role),
      provider: str(a.provider),
      port: num(a.port),
    })),
    deferred: Object.entries(isObj(o.deferred) ? o.deferred : {}).map(([workspaceId, reason]) => ({
      workspaceId,
      reason: str(reason),
    })),
    resources: resources ? { cpu: num(resources.cpu), mem: num(resources.mem) } : null,
    quota: Object.entries(isObj(o.quota) ? o.quota : {}).map(([provider, q]) => {
      const x = isObj(q) ? q : {};
      return {
        provider,
        level: str(x.level, "unknown"),
        remainingPct: typeof x.remainingPct === "number" ? x.remainingPct : null,
        resetsAt: typeof x.resetsAt === "string" ? x.resetsAt : null,
      };
    }),
    pool: Object.entries(pool).map(([name, d]) => {
      const x = isObj(d) ? d : {};
      return {
        name,
        kind: str(x.kind, "other"),
        leased: x.leased === true,
      };
    }),
  };
}

export interface DeviceView {
  id: string;
  kind: string;
  name: string;
  detail: string;
}

export function parseDevices(raw: unknown): DeviceView[] {
  const list = isObj(raw) && Array.isArray(raw.devices) ? raw.devices : [];
  return list.filter(isObj).map((d) => {
    const meta = isObj(d.meta) ? d.meta : {};
    return {
      id: str(d.id),
      kind: str(d.kind, "other"),
      name: str(d.name),
      detail: [meta.serial, meta.avd].filter((x) => typeof x === "string" && x).join(" · "),
    };
  });
}

export const fmtPct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

/** "claude=2, codex=1" <-> {claude: 2, codex: 1}; invalid parts are dropped. */
export function parseLimits(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of text.split(",")) {
    const [name, value] = part.split("=").map((s) => s.trim());
    const n = Number(value);
    if (name && Number.isInteger(n) && n >= 1) out[name] = n;
  }
  return out;
}

export const formatLimits = (limits: Record<string, number>): string =>
  Object.entries(limits)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

export function pauseReason(view: SchedulerView, threshold: number): string | null {
  if (!view.paused) return null;
  const mem = view.resources
    ? `（内存 ${fmtPct(view.resources.mem)}，阈值 ${fmtPct(threshold)}）`
    : "";
  return `内存超过阈值，已暂停放行新任务${mem}`;
}
