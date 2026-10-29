// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { VibeDb } from "./sqlite";

export interface RemoteHost {
  name: string;
  target: string;
}
export interface HostResource {
  name: string;
  target?: string;
  ts: string;
  availableBytes?: number;
  totalBytes?: number;
  cores?: number;
  load1?: number;
  cpu?: number;
  committedRatio?: number;
  error?: string;
}
export const RESOURCE_PRESSURE = {
  availableRatio: 0.15,
  availableBytes: 1.5 * 1024 ** 3,
  loadPerCore: 0.85,
  committedRatio: 0.9,
};
export { REMOTE_TARGET_PATTERN } from "../contract/resources";
export function resourcePressure(host: HostResource): string[] {
  if (host.error) return [];
  const reasons: string[] = [];
  if (
    host.availableBytes !== undefined &&
    host.totalBytes &&
    (host.availableBytes / host.totalBytes < RESOURCE_PRESSURE.availableRatio ||
      host.availableBytes < RESOURCE_PRESSURE.availableBytes)
  )
    reasons.push("可用内存不足");
  if (
    host.load1 !== undefined &&
    host.cores &&
    host.load1 > RESOURCE_PRESSURE.loadPerCore * host.cores
  )
    reasons.push("1 分钟负载过高");
  if (host.committedRatio !== undefined && host.committedRatio > RESOURCE_PRESSURE.committedRatio)
    reasons.push("已提交内存超过 90%");
  return reasons;
}
export function formatResourceHost(host: HostResource): string {
  if (host.error) return host.name + " 不可达";
  const parts = [host.name];
  if (host.cpu !== undefined) parts.push("CPU " + Math.round(host.cpu * 100) + "%");
  if (host.availableBytes !== undefined && host.totalBytes)
    parts.push(
      "内存余 " +
        (host.availableBytes / 1024 ** 3).toFixed(1) +
        "/" +
        Number((host.totalBytes / 1024 ** 3).toFixed(1)) +
        "GB",
    );
  if (host.load1 !== undefined && host.cores)
    parts.push("负载 " + host.load1.toFixed(1) + "/" + host.cores);
  return parts.join(" ") + (resourcePressure(host).length ? "（紧张）" : "");
}
export function readResourceMeta<T>(db: VibeDb, key: string, fallback: T): T {
  const row = db.prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?").get(key);
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function writeResourceMeta(db: VibeDb, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO vibe_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, JSON.stringify(value));
}
export function readResourceBriefing(db: VibeDb) {
  const local = readResourceMeta<HostResource | null>(db, "scheduler.local_resources", null);
  const remotes = readResourceMeta<HostResource[]>(db, "scheduler.remote_resources", []);
  const configured = readResourceMeta<RemoteHost[]>(db, "scheduler.remote_hosts", []);
  const hosts: HostResource[] = [local ?? { name: "本机", ts: "", error: "等待采样" }];
  for (const host of configured) {
    const sample = remotes.find((remote) => remote.target === host.target);
    hosts.push(sample ? { ...sample, name: host.name } : { ...host, ts: "", error: "等待采样" });
  }
  return {
    briefing: "资源：" + hosts.map(formatResourceHost).join("；"),
    tightItems: hosts.flatMap((h) => resourcePressure(h).map((reason) => h.name + "：" + reason)),
    hosts,
  };
}
