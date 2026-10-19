// Machine and per-session resource sampling. All OS access goes through `SystemProbe` so tests
// (and the scheduler tests) run with fake machines.
//
// Session attribution: a process belongs to a session when its command line mentions the
// session's working directory (worktree, else project dir); its descendants belong too. Sessions
// sharing one directory split that directory's usage evenly.

import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  rssBytes: number;
  /** Cumulative CPU time (user + kernel) in ms. */
  cpuMs: number;
}

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface SystemProbe {
  cpuTimes(): CpuTimes;
  cpuCount(): number;
  totalMem(): number;
  freeMem(): number;
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>;
  listProcesses(): Promise<ProcInfo[]>;
}

export interface SessionTarget {
  sessionId: string;
  cardKey?: string | null;
  /** Directory the session works in; null = cannot be attributed. */
  path: string | null;
}

export interface SessionUsage {
  memBytes: number;
  /** Fraction of the whole machine's CPU (0-1). */
  cpu: number;
  procs: number;
  cardKey: string | null;
}

export interface ResourceSnapshot {
  ts: string;
  /** 0-1 */
  cpu: number;
  /** 0-1 used physical memory. */
  mem: number;
  disk: { freeBytes: number; totalBytes: number } | null;
  perSession: Record<string, SessionUsage>;
}

const norm = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

export function createResourceSampler(options: {
  probe: SystemProbe;
  now?: () => Date;
  diskPath?: string;
}) {
  const { probe } = options;
  const now = options.now ?? (() => new Date());
  let lastCpu: CpuTimes | null = null;
  let lastProcs = new Map<number, number>();
  let lastAt: number | null = null;

  return {
    async sample(targets: readonly SessionTarget[]): Promise<ResourceSnapshot> {
      const at = now();
      const times = probe.cpuTimes();
      const dTotal = times.total - (lastCpu?.total ?? 0);
      const dIdle = times.idle - (lastCpu?.idle ?? 0);
      const cpu = dTotal > 0 ? clamp01(1 - dIdle / dTotal) : 0;
      lastCpu = times;

      const procs = await probe.listProcesses().catch(() => [] as ProcInfo[]);
      const wallMs = lastAt === null ? 0 : at.getTime() - lastAt;
      const perPid = new Map<number, number>();
      const cpuOf = (p: ProcInfo) => {
        const prev = lastProcs.get(p.pid);
        if (prev === undefined || wallMs <= 0 || p.cpuMs < prev) return 0;
        return (p.cpuMs - prev) / (wallMs * probe.cpuCount());
      };
      for (const p of procs) perPid.set(p.pid, cpuOf(p));
      lastProcs = new Map(procs.map((p) => [p.pid, p.cpuMs]));
      lastAt = at.getTime();

      const perSession = attribute(procs, perPid, targets);
      const total = probe.totalMem();
      const disk = options.diskPath ? await probe.disk(options.diskPath).catch(() => null) : null;
      return {
        ts: at.toISOString(),
        cpu,
        mem: total > 0 ? clamp01(1 - probe.freeMem() / total) : 0,
        disk,
        perSession,
      };
    },
  };
}

function attribute(
  procs: readonly ProcInfo[],
  cpuByPid: ReadonlyMap<number, number>,
  targets: readonly SessionTarget[],
): Record<string, SessionUsage> {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);

  const byPath = new Map<string, SessionTarget[]>();
  for (const t of targets) {
    if (!t.path) continue;
    byPath.set(norm(t.path), [...(byPath.get(norm(t.path)) ?? []), t]);
  }
  const out: Record<string, SessionUsage> = {};
  for (const t of targets) {
    out[t.sessionId] = { memBytes: 0, cpu: 0, procs: 0, cardKey: t.cardKey ?? null };
  }
  for (const [path, group] of byPath) {
    const seen = new Set<number>();
    const walk = (p: ProcInfo) => {
      if (seen.has(p.pid)) return;
      seen.add(p.pid);
      for (const c of children.get(p.pid) ?? []) walk(c);
    };
    for (const p of procs) if (norm(p.cmd).includes(path)) walk(p);
    let mem = 0;
    let cpu = 0;
    for (const pid of seen) {
      mem += procs.find((p) => p.pid === pid)?.rssBytes ?? 0;
      cpu += cpuByPid.get(pid) ?? 0;
    }
    for (const t of group) {
      out[t.sessionId] = {
        memBytes: Math.round(mem / group.length),
        cpu: clamp01(cpu / group.length),
        procs: Math.ceil(seen.size / group.length),
        cardKey: t.cardKey ?? null,
      };
    }
  }
  return out;
}

/** Largest memory consumers first. */
export function topSessions(snapshot: ResourceSnapshot, n = 3) {
  return Object.entries(snapshot.perSession)
    .map(([sessionId, u]) => ({ sessionId, cardKey: u.cardKey, memBytes: u.memBytes }))
    .filter((s) => s.memBytes > 0)
    .sort((a, b) => b.memBytes - a.memBytes)
    .slice(0, n);
}

// --- real probe -----------------------------------------------------------------------------

export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const WIN_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";

/** Win32_Process JSON (times are 100 ns units). */
export function parseWindowsProcesses(json: string): ProcInfo[] {
  if (!json.trim()) return [];
  const raw = JSON.parse(json) as unknown;
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    name: String(r.Name ?? ""),
    cmd: String(r.CommandLine ?? ""),
    rssBytes: Number(r.WorkingSetSize ?? 0),
    cpuMs: (Number(r.KernelModeTime ?? 0) + Number(r.UserModeTime ?? 0)) / 10_000,
  }));
}

function parsePsTime(s: string): number {
  const [dayPart, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest!.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts as [number, number, number];
  return (((Number(dayPart) * 24 + h) * 60 + m) * 60 + sec) * 1000;
}

/** `ps -eo pid=,ppid=,rss=,time=,args=` output (rss in KiB). */
export function parsePsProcesses(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[5]!;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: cmd.split(/\s+/)[0]!.split("/").pop()!,
      cmd,
      rssBytes: Number(m[3]) * 1024,
      cpuMs: parsePsTime(m[4]!),
    });
  }
  return out;
}

export function createSystemProbe(run: CommandRunner = runCommand): SystemProbe {
  return {
    cpuTimes() {
      let idle = 0;
      let total = 0;
      for (const c of cpus()) {
        const t = c.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
      }
      return { idle, total };
    },
    cpuCount: () => Math.max(1, cpus().length),
    totalMem: totalmem,
    freeMem: freemem,
    async disk(path) {
      const s = await statfs(path);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    },
    async listProcesses() {
      if (process.platform === "win32") {
        return parseWindowsProcesses(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_QUERY]));
      }
      return parsePsProcesses(await run("ps", ["-eo", "pid=,ppid=,rss=,time=,args="]));
    },
  };
}
