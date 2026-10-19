// Does the installed Claude Code already compact idle sessions itself? If so only that native
// feature is used for claude. Offline: probes the local CLI only. Replaceable via
// `CompactionOptions.detectNative`.

import { execFile } from "node:child_process";

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

export const execRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 10_000, windowsHide: true, shell: process.platform === "win32" },
      (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}\n${stderr}`)),
    );
  });

/** Claude Code release that first shipped idle compaction; unknown until confirmed. */
export const NATIVE_MIN_VERSION: string | null = null;

const IDLE_COMPACT_FLAG = /idle[-_ ]?compact/i;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export async function detectNativeIdleCompaction(
  run: CommandRunner = execRunner,
  minVersion: string | null = NATIVE_MIN_VERSION,
): Promise<boolean> {
  try {
    if (IDLE_COMPACT_FLAG.test(await run("claude", ["--help"]))) return true;
    if (minVersion) {
      const version = /(\d+\.\d+\.\d+)/.exec(await run("claude", ["--version"]))?.[1];
      return version !== undefined && compareVersions(version, minVersion) >= 0;
    }
  } catch {
    // No claude binary or probe failed: treat as unsupported.
  }
  return false;
}
