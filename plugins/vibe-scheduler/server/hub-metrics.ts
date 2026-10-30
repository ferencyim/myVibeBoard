// Machine metrics the hub admits against (the same set win-heavy-guard uses). A field that cannot
// be read stays undefined and is treated as "unknown, does not block".

import { cpus, freemem } from "node:os";
import { runCommand, type CommandRunner } from "./resources";

export interface HubMetrics {
  ts: string;
  availableGb?: number;
  commitPercent?: number;
  /** Average over the CPU window. */
  cpuPercent?: number;
  processes?: number;
  handles?: number;
  diskQueue?: number;
}

// CIM perf classes are locale independent (Get-Counter names are not).
const WIN_QUERY = `$ErrorActionPreference='SilentlyContinue'
$m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$s = Get-CimInstance Win32_PerfFormattedData_PerfOS_System
$p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name='_Total'"
$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
[pscustomobject]@{ commit=$m.PercentCommittedBytesInUse; processes=$s.Processes; handles=$p.HandleCount; diskQueue=$d.CurrentDiskQueueLength } | ConvertTo-Json -Compress`;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function createHubMetrics(options: {
  run?: CommandRunner;
  now?: () => Date;
  cacheMs?: number;
  cpuWindowSeconds: () => number;
  platform?: NodeJS.Platform;
}) {
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date());
  const cacheMs = options.cacheMs ?? 5000;
  const platform = options.platform ?? process.platform;
  const cpuSamples: Array<{ at: number; idle: number; total: number }> = [];
  let cached: { at: number; value: HubMetrics } | null = null;
  let inflight: Promise<HubMetrics> | null = null;

  function cpuPercent(at: number): number | undefined {
    let idle = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    cpuSamples.push({ at, idle, total });
    const horizon = at - options.cpuWindowSeconds() * 1000;
    while (cpuSamples.length > 2 && cpuSamples[1]!.at <= horizon) cpuSamples.shift();
    const first = cpuSamples[0]!;
    const dTotal = total - first.total;
    return dTotal > 0 ? Math.round((1 - (idle - first.idle) / dTotal) * 1000) / 10 : undefined;
  }

  async function collect(): Promise<HubMetrics> {
    const at = now().getTime();
    const value: HubMetrics = {
      ts: new Date(at).toISOString(),
      availableGb: Math.round((freemem() / 1024 ** 3) * 100) / 100,
      cpuPercent: cpuPercent(at),
    };
    if (platform === "win32") {
      try {
        const row = JSON.parse(
          await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_QUERY], 8000),
        ) as Record<string, unknown>;
        value.commitPercent = num(row.commit);
        value.processes = num(row.processes);
        value.handles = num(row.handles);
        value.diskQueue = num(row.diskQueue);
      } catch {
        // unknown: leave the fields undefined
      }
    }
    return value;
  }

  return {
    /** Cached for cacheMs; concurrent callers share one collection. */
    async read(force = false): Promise<HubMetrics> {
      if (!force && cached && now().getTime() - cached.at < cacheMs) return cached.value;
      inflight ??= collect()
        .then((value) => {
          cached = { at: now().getTime(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
export type HubMetricsReader = ReturnType<typeof createHubMetrics>;
