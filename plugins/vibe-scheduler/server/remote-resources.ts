import { runCommand, type CommandRunner } from "./resources";
import { REMOTE_TARGET_PATTERN, type HostResource, type RemoteHost } from "./vibe/db";

export const REMOTE_RESOURCE_COMMAND =
  'case "$(uname -s)" in Darwin) echo Darwin; sysctl -n hw.memsize hw.ncpu vm.loadavg; vm_stat ;; Linux) echo Linux; getconf _NPROCESSORS_ONLN; cat /proc/meminfo; cat /proc/loadavg ;; *) exit 1 ;; esac';
export function parseRemoteResources(
  text: string,
): Pick<HostResource, "availableBytes" | "totalBytes" | "cores" | "load1"> {
  const lines = text.trim().split(/\r?\n/);
  let totalBytes: number, availableBytes: number, cores: number, load1: number;
  if (lines[0] === "Darwin") {
    totalBytes = Number(lines[1]);
    cores = Number(lines[2]);
    load1 = Number(lines[3]?.match(/^\s*\{\s*(-?\d+(?:\.\d+)?)/)?.[1]);
    const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
    if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("远程内存页大小无效");
    const pages = ["free", "inactive", "speculative"].map((kind) =>
      Number(text.match(new RegExp("Pages " + kind + ":\\s*(\\d+)"))?.[1]),
    );
    availableBytes = pages.reduce((a, b) => a + b, 0) * pageSize;
  } else if (lines[0] === "Linux") {
    cores = Number(lines[1]);
    totalBytes = Number(text.match(/MemTotal:\s*(\d+)/)?.[1]) * 1024;
    availableBytes = Number(text.match(/MemAvailable:\s*(\d+)/)?.[1]) * 1024;
    load1 = Number(lines.at(-1)?.split(/\s+/)[0]);
  } else throw new Error("不支持的远程操作系统");
  if (
    ![totalBytes, availableBytes, cores, load1].every(Number.isFinite) ||
    totalBytes <= 0 ||
    availableBytes < 0 ||
    availableBytes > totalBytes ||
    !Number.isInteger(cores) ||
    cores <= 0 ||
    load1 < 0
  )
    throw new Error("远程资源采样格式无效");
  return { totalBytes, availableBytes, cores, load1 };
}
export async function sampleRemoteHost(
  host: RemoteHost,
  run: CommandRunner = runCommand,
  now = new Date(),
): Promise<HostResource> {
  try {
    if (!REMOTE_TARGET_PATTERN.test(host.target)) throw new Error("SSH 目标须为 user@host");
    const text = await run("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      host.target,
      REMOTE_RESOURCE_COMMAND,
    ]);
    return { ...host, ts: now.toISOString(), ...parseRemoteResources(text) };
  } catch (error) {
    return {
      ...host,
      ts: now.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
