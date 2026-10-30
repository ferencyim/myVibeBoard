// Mixed-mode safety: the hub mirrors every job it admits into the lock directory as the same
// `slot-<n>-<pid>-<token>` holder directories win-heavy-guard's local mode writes, and counts the
// local holders it finds there. Either mode then sees the other's running jobs.

import { mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Must match CODE_VERSION in ci-dashboard queue/win-heavy-guard.py (other versions count as legacy).
const GUARD_CODE_VERSION = 2;

export interface MirroredJob {
  id: string;
  owner: string;
  pid: number;
  priority: number;
  exclusive: boolean;
  units?: number;
  memGb?: number;
  command: string;
  commandSha256: string;
  resources?: Array<{ name: string; mode: "shared" | "exclusive" }>;
}

export interface LocalHolders {
  /** Slot directories held by local-mode guards (one per slot, like the guard counts them). */
  slots: number;
  exclusive: boolean;
}

const tokenOf = (jobId: string) => jobId.replaceAll("-", "");

function readOwner(dir: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.txt"), "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function removeDir(dir: string) {
  try {
    unlinkSync(join(dir, "owner.txt"));
  } catch {
    // already gone
  }
  try {
    rmdirSync(dir); // never recursive
  } catch {
    // not empty or gone
  }
}

function slotDirs(lockDir: string): Array<{ name: string; dir: string }> {
  try {
    return readdirSync(lockDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("slot-"))
      .map((e) => ({ name: e.name, dir: join(lockDir, e.name) }));
  } catch {
    return [];
  }
}

/** Write holder directories for an admitted job; returns the directories created. */
export function mirrorJob(lockDir: string, job: MirroredJob, now: Date): string[] {
  mkdirSync(lockDir, { recursive: true });
  const token = tokenOf(job.id);
  const used = new Set(slotDirs(lockDir).map((d) => Number(d.name.split("-")[1])));
  const count = job.exclusive ? 1 : (job.units ?? 1);
  const created: string[] = [];
  for (let n = 1; created.length < count; n++) {
    if (used.has(n)) continue;
    const dir = join(lockDir, `slot-${n}-${job.pid}-${token}`);
    mkdirSync(dir);
    created.push(dir);
    const ts = now.getTime() / 1000;
    writeFileSync(
      join(dir, "owner.txt"),
      JSON.stringify({
        token,
        owner: job.owner,
        pid: job.pid,
        code_version: GUARD_CODE_VERSION,
        queued_at: ts,
        heartbeat: ts,
        started_at: ts,
        priority: job.priority,
        exclusive: job.exclusive,
        mem_gb: job.memGb ?? 0,
        locked_resources: job.resources ?? [],
        admission_path: "hub",
        command_sha256: job.commandSha256,
        command: job.command.slice(0, 120),
        via: "hub",
        hub_job_id: job.id,
      }),
    );
  }
  return created;
}

/** Remove the directories of one hub job (only ones whose owner.txt is ours). */
export function unmirrorJob(lockDir: string, jobId: string) {
  const token = tokenOf(jobId);
  for (const { dir } of slotDirs(lockDir)) {
    if (readOwner(dir)?.token === token) removeDir(dir);
  }
}

/**
 * Local-mode holders: slot directories that are not the hub's own jobs (`ownJobIds`) and whose
 * process is alive. A directory without readable metadata counts as an exclusive unknown holder,
 * like the guard treats it. Hub-written directories of dead processes are swept.
 */
export function readLocalHolders(
  lockDir: string,
  ownJobIds: Iterable<string>,
  isPidAlive: (pid: number) => boolean,
): LocalHolders {
  const own = new Set([...ownJobIds].map(tokenOf));
  const out: LocalHolders = { slots: 0, exclusive: false };
  for (const { name, dir } of slotDirs(lockDir)) {
    const data = readOwner(dir);
    const parts = name.split("-");
    if (data?.token && own.has(String(data.token))) continue;
    if (!data && own.has(parts[parts.length - 1]!)) continue;
    const pid = Number(data?.pid ?? parts[2]);
    const childPid = Number(data?.child_pid);
    const alive = (pid > 0 && isPidAlive(pid)) || (childPid > 0 && isPidAlive(childPid));
    if (!alive) {
      if (data?.via === "hub") removeDir(dir);
      continue;
    }
    out.slots += 1;
    if (!data || data.exclusive !== false) out.exclusive = true;
  }
  return out;
}
