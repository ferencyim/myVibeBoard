// Pure model of the 「中枢」 page: loose RPC records -> typed views, queue ordering, form validation.
// The hub RPCs come from WP-170/172; every field is parsed defensively so a missing part is an empty state.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const num = (v: unknown, fallback = 0) => numOrNull(v) ?? fallback;
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

export type QueueKind = "agent" | "shell";
export type QueueState = "running" | "queued" | "paused";

export interface QueueItem {
  id: string;
  kind: QueueKind;
  /** Source session or project. */
  owner: string;
  project: string;
  /** Command summary (shell jobs) or task title (agent tasks). */
  command: string;
  priority: number;
  state: QueueState;
  waitReasons: string[];
  queuedAt: string | null;
}

export interface HubHolder {
  jobId: string;
  owner: string;
  mode: string;
}
export interface HubResource {
  name: string;
  limit: number;
  holders: HubHolder[];
}
export interface HubPause {
  id: string;
  scope: string;
  until: string | null;
  reason: string;
  issuedBy: string;
}
export interface HubMachine {
  availableMemGb: number | null;
  commitRatio: number | null;
  cpu: number | null;
  processes: number | null;
  handles: number | null;
  diskQueue: number | null;
}
export interface HubJobRecord {
  id: string;
  owner: string;
  project: string;
  command: string;
  priority: number;
  queuedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  outcome: "released" | "reaped";
}
export interface HubAgents {
  /** Running agent sessions the scheduler counts, if reported. */
  running: number | null;
}
export interface HubStatus {
  machine: HubMachine;
  queue: QueueItem[];
  resources: HubResource[];
  pauses: HubPause[];
  agents: HubAgents;
  recentJobs: HubJobRecord[];
  /** Resource names jobs asked for that are not registered. */
  unregisteredResources: string[];
}

export const EMPTY_HUB_STATUS: HubStatus = {
  machine: {
    availableMemGb: null,
    commitRatio: null,
    cpu: null,
    processes: null,
    handles: null,
    diskQueue: null,
  },
  queue: [],
  resources: [],
  pauses: [],
  agents: { running: null },
  recentJobs: [],
  unregisteredResources: [],
};

export function parseHubStatus(raw: unknown): HubStatus {
  const o: Obj = isObj(raw) ? raw : {};
  const m = isObj(o.machine) ? o.machine : {};
  return {
    machine: {
      availableMemGb: numOrNull(m.availableMemGb),
      commitRatio: numOrNull(m.commitRatio),
      cpu: numOrNull(m.cpu),
      processes: numOrNull(m.processes),
      handles: numOrNull(m.handles),
      diskQueue: numOrNull(m.diskQueue),
    },
    queue: list(o.queue).map((q) => ({
      id: str(q.id),
      kind: q.kind === "agent" ? "agent" : "shell",
      owner: str(q.owner),
      project: str(q.project),
      command: str(q.command),
      priority: num(q.priority, 5),
      state: q.state === "running" || q.state === "paused" ? q.state : "queued",
      waitReasons: (Array.isArray(q.waitReasons) ? q.waitReasons : []).filter(
        (r): r is string => typeof r === "string",
      ),
      queuedAt: typeof q.queuedAt === "string" ? q.queuedAt : null,
    })),
    resources: list(o.resources).map((r) => ({
      name: str(r.name),
      limit: Math.max(1, num(r.limit, 1)),
      holders: list(r.holders).map((h) => ({
        jobId: str(h.jobId),
        owner: str(h.owner),
        mode: str(h.mode, "exclusive"),
      })),
    })),
    pauses: list(o.pauses).map((p) => ({
      id: str(p.id),
      scope: str(p.scope),
      until: typeof p.until === "string" ? p.until : null,
      reason: str(p.reason),
      issuedBy: str(p.issuedBy, "user"),
    })),
    agents: {
      running: isObj(o.agents) && isObj(o.agents.running) ? numOrNull(o.agents.running.total) : null,
    },
    recentJobs: list(o.recentJobs).map((j) => ({
      id: str(j.id),
      owner: str(j.owner),
      project: str(j.project),
      command: str(j.command),
      priority: num(j.priority, 1),
      queuedAt: typeof j.queuedAt === "string" ? j.queuedAt : null,
      finishedAt: typeof j.finishedAt === "string" ? j.finishedAt : null,
      exitCode: numOrNull(j.exitCode),
      durationMs: numOrNull(j.durationMs),
      outcome: j.outcome === "reaped" ? "reaped" : "released",
    })),
    unregisteredResources: (Array.isArray(o.unregisteredResources) ? o.unregisteredResources : []).filter(
      (n): n is string => typeof n === "string",
    ),
  };
}

// ---- thresholds -----------------------------------------------------------------------------

export interface ThresholdField {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  int: boolean;
  /** Which live metric this threshold guards; the page shows both side by side. */
  metric?: keyof HubMachine;
}

/** Mirrors win-heavy-guard.admission.json. */
export const THRESHOLD_FIELDS: ThresholdField[] = [
  { key: "minAvailableMemGb", label: "可用内存下限", unit: "GB", min: 0, max: 1024, int: false, metric: "availableMemGb" },
  { key: "deployMinAvailableMemGb", label: "部署可用内存下限", unit: "GB", min: 0, max: 1024, int: false },
  { key: "maxCommitRatio", label: "已承诺内存上限", unit: "%", min: 0.1, max: 1, int: false, metric: "commitRatio" },
  { key: "maxCpu", label: "CPU 上限", unit: "%", min: 0.1, max: 1, int: false, metric: "cpu" },
  { key: "cpuWindowSeconds", label: "CPU 统计窗口", unit: "秒", min: 1, max: 600, int: true },
  { key: "maxProcesses", label: "进程数上限", unit: "个", min: 10, max: 100000, int: true, metric: "processes" },
  { key: "maxHandles", label: "句柄数上限", unit: "个", min: 1000, max: 10000000, int: true, metric: "handles" },
  { key: "maxDiskQueue", label: "磁盘队列上限", unit: "队列长度", min: 0.1, max: 1000, int: false, metric: "diskQueue" },
  { key: "minStartIntervalSec", label: "两次启动最小间隔", unit: "秒", min: 0, max: 3600, int: true },
  { key: "heavyHardLimit", label: "重任务硬上限", unit: "个", min: 1, max: 64, int: true },
];

export type Thresholds = Record<string, number>;

export function parseThresholds(raw: unknown): Thresholds {
  const src = isObj(raw) ? (isObj(raw.thresholds) ? raw.thresholds : raw) : {};
  const out: Thresholds = {};
  for (const f of THRESHOLD_FIELDS) {
    const v = numOrNull(src[f.key]);
    if (v !== null) out[f.key] = v;
  }
  return out;
}

/** Ratio thresholds are stored as 0–1 and shown/typed as percentages. */
export const isPercentField = (f: Pick<ThresholdField, "unit">) => f.unit === "%";

/** Stored value -> the number the user sees and edits (80 for 0.8 on a percent field). */
export function thresholdToDisplay(f: Pick<ThresholdField, "unit">, value: number): number {
  return isPercentField(f) ? Math.round(value * 10000) / 100 : value;
}

/** Display range of a field (10–100 for a 0.1–1 ratio). */
export function thresholdDisplayRange(f: Pick<ThresholdField, "unit" | "min" | "max">) {
  return { min: thresholdToDisplay(f, f.min), max: thresholdToDisplay(f, f.max) };
}

/** Parses what the user typed (percent for ratio fields) back into the stored value, or null when invalid. */
export function parseThresholdInput(text: string, f: ThresholdField): number | null {
  const n = parseNumberField(text.replace(/%\s*$/, ""), { ...thresholdDisplayRange(f), int: f.int });
  if (n === null) return null;
  return isPercentField(f) ? Math.round(n * 100) / 10000 : n;
}

/** Returns the number, or null when the text is not a valid value for the field. */
export function parseNumberField(
  text: string,
  f: Pick<ThresholdField, "min" | "max" | "int">,
): number | null {
  if (!text.trim()) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < f.min || n > f.max) return null;
  if (f.int && !Number.isInteger(n)) return null;
  return n;
}

/** Whether the live metric is past its threshold (for the amber highlight). */
export function metricExceeds(
  field: ThresholdField,
  machine: HubMachine,
  thresholds: Thresholds,
): boolean {
  if (!field.metric) return false;
  const value = machine[field.metric];
  const limit = thresholds[field.key];
  if (value === null || limit === undefined) return false;
  return field.key.startsWith("min") ? value < limit : value > limit;
}

export function formatMetric(field: ThresholdField, value: number | null): string {
  if (value === null) return "—";
  if (isPercentField(field)) return `${Math.round(value * 100)}%`;
  if (field.unit === "GB") return `${value.toFixed(1)} GB`;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// ---- queue ----------------------------------------------------------------------------------

export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 9;

/** Running items stay on top; waiting items keep the manual order the hub sent. */
export function sortQueue(items: readonly QueueItem[]): QueueItem[] {
  const rank = (s: QueueState) => (s === "running" ? 0 : 1);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.state) - rank(b.item.state) || a.index - b.index)
    .map((x) => x.item);
}

export function moveQueueItem(items: readonly QueueItem[], id: string, delta: -1 | 1): QueueItem[] {
  const next = [...items];
  const from = next.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= next.length) return next;
  // Running items are not reorderable and not displaced.
  if (next[from]?.state === "running" || next[to]?.state === "running") return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as QueueItem);
  return next;
}

export function setQueuePriority(
  items: readonly QueueItem[],
  id: string,
  priority: number,
): QueueItem[] {
  const p = Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(priority)));
  return items.map((i) => (i.id === id ? { ...i, priority: p } : i));
}

export const queueOrderIds = (items: readonly QueueItem[]) =>
  items.filter((i) => i.state !== "running").map((i) => i.id);

export function queueSource(item: QueueItem): string {
  const who = [item.project, item.owner].filter(Boolean).join(" · ");
  return who || (item.kind === "agent" ? "agent 任务" : "重任务");
}

export const STATE_ZH: Record<QueueState, string> = {
  running: "运行中",
  queued: "排队",
  paused: "被暂停",
};

// ---- pauses ---------------------------------------------------------------------------------

export const PAUSE_SCOPES = [
  { value: "all-heavy", label: "全部重任务" },
  { value: "build", label: "构建" },
  { value: "test", label: "测试" },
  { value: "deploy", label: "部署" },
  { value: "db", label: "数据库" },
  { value: "agents", label: "新 agent 任务" },
  { value: "pg:*", label: "所有 PG 实例" },
] as const;

export const PAUSE_MAX_MINUTES = 7 * 24 * 60;

export interface PauseForm {
  scope: string;
  minutes: string;
  reason: string;
}
export type PauseInput = { scope: string; until: string; reason: string };

export function validatePauseForm(
  form: PauseForm,
  now: Date,
): { ok: true; value: PauseInput } | { ok: false; error: string } {
  const scope = form.scope.trim();
  if (!scope) return { ok: false, error: "请填写范围" };
  const minutes = parseNumberField(form.minutes, { min: 1, max: PAUSE_MAX_MINUTES, int: true });
  if (minutes === null) return { ok: false, error: "时长需为 1 分钟到 7 天的整数分钟" };
  const reason = form.reason.trim();
  if (!reason) return { ok: false, error: "请填写原因" };
  return {
    ok: true,
    value: { scope, until: new Date(now.getTime() + minutes * 60_000).toISOString(), reason },
  };
}

/** "还剩 1 小时 5 分" / "已到期" / "无期限". */
export function formatRemaining(until: string | null, now: Date): string {
  if (!until) return "无期限";
  const ms = new Date(until).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return "无期限";
  if (ms <= 0) return "已到期";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `还剩 ${min} 分`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `还剩 ${h} 小时 ${min % 60} 分` : `还剩 ${h} 小时`;
  return `还剩 ${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

export function formatClock(iso: string | null): string {
  return iso ? iso.slice(5, 16).replace("T", " ") : "";
}

// ---- resources ------------------------------------------------------------------------------

export const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

export function validateResourceForm(
  name: string,
  limit: string,
  existing: readonly string[],
  editing: boolean,
): { ok: true; value: { name: string; limit: number } } | { ok: false; error: string } {
  const n = name.trim();
  if (!RESOURCE_NAME_PATTERN.test(n)) {
    return { ok: false, error: "名称只能含字母、数字和 : . _ -，例如 pg:5435" };
  }
  if (!editing && existing.includes(n)) return { ok: false, error: "资源已存在" };
  const l = parseNumberField(limit, { min: 1, max: 64, int: true });
  if (l === null) return { ok: false, error: "并发上限需为 1 到 64 的整数" };
  return { ok: true, value: { name: n, limit: l } };
}

// ---- directives -----------------------------------------------------------------------------

export type DirectiveStatus = "active" | "pending" | "revoked" | "expired";
export interface Directive {
  id: string;
  text: string;
  /** "all" or a readable summary of the project/provider list. */
  scope: string;
  kind: "temporary" | "standing";
  expiresAt: string | null;
  issuedBy: "user" | "bot";
  status: DirectiveStatus;
  createdAt: string | null;
  updatedAt: string | null;
  /** Pause rule enforced while the directive is active. */
  pause: { scope: string; until: string | null } | null;
}

/** The hub sends scope as "all" or { kind: "projects" | "providers", ... }. */
export function formatDirectiveScope(scope: unknown): string {
  if (scope === undefined || scope === null || scope === "all") return "all";
  if (!isObj(scope)) return typeof scope === "string" ? scope : "all";
  if (scope.kind === "projects" && Array.isArray(scope.projectIds))
    return `项目：${scope.projectIds.join("、")}`;
  if (scope.kind === "providers" && Array.isArray(scope.providers))
    return `模型提供方：${scope.providers.join("、")}`;
  return "all";
}

export function parseDirectives(raw: unknown): Directive[] {
  const arr = isObj(raw) ? raw.directives : raw;
  return list(arr).map((d) => ({
    id: str(d.id),
    text: str(d.text),
    scope: formatDirectiveScope(d.scope),
    kind: d.kind === "standing" ? "standing" : "temporary",
    expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
    issuedBy: d.issuedBy === "bot" ? "bot" : "user",
    status:
      d.status === "pending" || d.status === "revoked" || d.status === "expired"
        ? d.status
        : "active",
    createdAt: typeof d.createdAt === "string" ? d.createdAt : null,
    updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
    pause: isObj(d.pause)
      ? { scope: str(d.pause.scope), until: typeof d.pause.until === "string" ? d.pause.until : null }
      : null,
  }));
}

// ---- takeover -------------------------------------------------------------------------------

export interface Takeover {
  enabled: boolean;
  active: boolean;
  available: boolean;
  disabledFile: boolean;
}
export const EMPTY_TAKEOVER: Takeover = { enabled: false, active: false, available: false, disabledFile: false };

export function parseTakeover(raw: unknown): Takeover {
  const o: Obj = isObj(raw) ? raw : {};
  return {
    enabled: o.enabled === true,
    active: o.active === true,
    available: o.available === true,
    disabledFile: o.disabledFile === true,
  };
}

export function takeoverLabel(t: Takeover): { text: string; warn: boolean } {
  if (!t.available) return { text: "本机未配置中枢目录，无法接管", warn: true };
  if (t.enabled && t.disabledFile)
    return { text: "已开启，但锁目录有 hub.disabled，guard 仍走本地锁", warn: true };
  if (t.enabled && t.active) return { text: "接管中：全机重任务经中枢排队", warn: false };
  if (t.enabled) return { text: "已开启，正在启动中枢接口", warn: true };
  return { text: "未接管：guard 使用本地锁（默认）", warn: false };
}

// ---- job records ----------------------------------------------------------------------------

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min} 分 ${sec % 60} 秒` : `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

export function jobOutcomeText(job: Pick<HubJobRecord, "outcome" | "exitCode">): string {
  if (job.outcome === "reaped") return "客户端失联，已回收";
  if (job.exitCode === null) return "已结束";
  return job.exitCode === 0 ? "成功" : `失败（退出码 ${job.exitCode}）`;
}

export function groupDirectives(items: readonly Directive[]) {
  const newest = (a: Directive, b: Directive) =>
    (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  const pick = (f: (d: Directive) => boolean) => items.filter(f).sort(newest);
  return {
    active: pick((d) => d.status === "active"),
    pending: pick((d) => d.status === "pending"),
    history: pick((d) => d.status === "revoked" || d.status === "expired"),
  };
}

export interface DirectiveForm {
  text: string;
  kind: "temporary" | "standing";
  hours: string;
}
export type DirectiveInput = {
  text: string;
  scope: string;
  kind: "temporary" | "standing";
  expiresAt?: string;
};

export function validateDirectiveForm(
  form: DirectiveForm,
  now: Date,
): { ok: true; value: DirectiveInput } | { ok: false; error: string } {
  const text = form.text.trim();
  if (!text) return { ok: false, error: "请填写指令内容" };
  if (text.length > 2000) return { ok: false, error: "指令不超过 2000 字" };
  if (form.kind === "standing") return { ok: true, value: { text, scope: "all", kind: "standing" } };
  const hours = parseNumberField(form.hours, { min: 1, max: 24 * 30, int: true });
  if (hours === null) return { ok: false, error: "临时指令的有效期需为 1 小时到 30 天" };
  return {
    ok: true,
    value: {
      text,
      scope: "all",
      kind: "temporary",
      expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    },
  };
}
