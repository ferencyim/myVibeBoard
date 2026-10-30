// Shapes the hub page and RPC callers use (ratios 0-1, renamed thresholds). The hub core keeps the
// guard units (percent, GB).

import type { HubResource } from "./hub-store";
import { describeWaitReason, type Hub, type HubSettings } from "./hub";

type HubStatus = Awaited<ReturnType<Hub["status"]>>;

export function toThresholds(s: HubSettings) {
  return {
    minAvailableMemGb: s.minAvailableGb,
    deployMinAvailableMemGb: s.deployMinAvailableGb,
    maxCommitRatio: s.maxCommitPercent / 100,
    maxCpu: s.maxCpuPercent / 100,
    cpuWindowSeconds: s.cpuWindowSeconds,
    maxProcesses: s.maxProcesses,
    maxHandles: s.maxHandles,
    maxDiskQueue: s.maxDiskQueueLength,
    minStartIntervalSec: s.admissionIntervalSeconds,
    heavyHardLimit: s.hardLimit,
  };
}

export function fromThresholds(t: Partial<ReturnType<typeof toThresholds>>): Partial<HubSettings> {
  const out: Partial<HubSettings> = {};
  if (t.minAvailableMemGb !== undefined) out.minAvailableGb = t.minAvailableMemGb;
  if (t.deployMinAvailableMemGb !== undefined) out.deployMinAvailableGb = t.deployMinAvailableMemGb;
  if (t.maxCommitRatio !== undefined) out.maxCommitPercent = t.maxCommitRatio * 100;
  if (t.maxCpu !== undefined) out.maxCpuPercent = t.maxCpu * 100;
  if (t.cpuWindowSeconds !== undefined) out.cpuWindowSeconds = t.cpuWindowSeconds;
  if (t.maxProcesses !== undefined) out.maxProcesses = t.maxProcesses;
  if (t.maxHandles !== undefined) out.maxHandles = t.maxHandles;
  if (t.maxDiskQueue !== undefined) out.maxDiskQueueLength = t.maxDiskQueue;
  if (t.minStartIntervalSec !== undefined) out.admissionIntervalSeconds = t.minStartIntervalSec;
  if (t.heavyHardLimit !== undefined) out.hardLimit = t.heavyHardLimit;
  return out;
}

export const toPageResource = (r: HubResource) => ({
  name: r.name,
  limit: r.maxShared,
  note: r.note,
});

export function toPageStatus(status: HubStatus) {
  const m = status.machine.metrics;
  const running = status.holders.map((h) => ({
    id: h.jobId,
    kind: "shell" as const,
    owner: h.owner,
    project: h.project,
    command: h.command,
    priority: h.priority,
    state: "running" as const,
    waitReasons: [] as string[],
    queuedAt: h.admittedAt,
  }));
  const queued = status.queue.map((q) => ({
    id: q.id,
    kind: q.kind === "agent" ? ("agent" as const) : ("shell" as const),
    owner: q.owner,
    project: q.project,
    command: q.summary,
    priority: q.priority,
    state: q.waitReasons.some((w) => w.startsWith("pause:"))
      ? ("paused" as const)
      : ("queued" as const),
    waitReasons: q.waitReasons.map(describeWaitReason),
    queuedAt: q.queuedAt,
  }));
  return {
    machine: {
      availableMemGb: m.availableGb ?? null,
      commitRatio: m.commitPercent === undefined ? null : m.commitPercent / 100,
      cpu: m.cpuPercent === undefined ? null : m.cpuPercent / 100,
      processes: m.processes ?? null,
      handles: m.handles ?? null,
      diskQueue: m.diskQueue ?? null,
      blockedBy: status.machine.blockedBy,
    },
    queue: [...running, ...queued],
    resources: status.resources.map((r) => ({
      name: r.name,
      limit: r.maxShared,
      holders: r.holders,
    })),
    unregisteredResources: status.unregisteredResources,
    pauses: status.pauses.map((p) => ({
      id: p.id,
      scope: p.scope,
      until: p.until,
      reason: p.reason,
      issuedBy: p.issuedBy,
    })),
    agents: status.agents,
    recentJobs: status.recentJobs,
  };
}
