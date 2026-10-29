import { z } from "zod";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { diagnosticText } from "./detection";

/** Fixed commands only: no user text, command line or process environment is collected. */
export async function relatedProcesses(provider: string) {
  const names: Record<string, string[]> = {
    codex: ["codex", "codex-app-server"],
    claude: ["claude"],
    opencode: ["opencode"],
    copilot: ["copilot"],
    pi: ["pi"],
  };
  const selected = names[provider.toLowerCase()];
  if (!selected) return { processes: [], unavailable: "此 provider 未提供可识别的进程名" };
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const args =
        process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-Process -Name " +
                selected.join(",") +
                " -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU | ConvertTo-Json -Compress",
            ]
          : ["-eo", "pid=,comm=,time="];
      execFile(
        process.platform === "win32" ? "powershell.exe" : "ps",
        args,
        { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 },
        (error, output) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(output);
        },
      );
    });
    if (process.platform === "win32") {
      const raw: unknown = stdout.trim() ? JSON.parse(stdout) : [];
      const parsed = z
        .array(z.object({ Id: z.number(), ProcessName: z.string(), CPU: z.number().nullable() }))
        .parse(Array.isArray(raw) ? raw : [raw]);
      return {
        processes: (Array.isArray(parsed) ? parsed : [parsed]).map(
          (entry: { Id: number; ProcessName: string; CPU: number | null }) => ({
            pid: entry.Id,
            name: entry.ProcessName,
            cpuSeconds: entry.CPU,
          }),
        ),
        scope: "同 provider 进程；不宣称进程属于特定 tab",
      };
    }
    return {
      processes: stdout.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)$/);
        return match && selected.some((name) => match[2].endsWith(name))
          ? [{ pid: Number(match[1]), name: match[2].split("/").at(-1), cpuTime: match[3] }]
          : [];
      }),
      scope: "同 provider 进程；不宣称进程属于特定 tab",
    };
  } catch (error) {
    return { processes: [], unavailable: diagnosticText(String(error)) };
  }
}
export async function recentDaemonLog(agentId: string) {
  let file;
  try {
    file = await open(join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "daemon.log"), "r");
    const stat = await file.stat();
    const length = Math.min(stat.size, 128 * 1024);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, stat.size - length);
    return {
      lines: buffer
        .toString("utf8")
        .split("\n")
        .filter((line) => line.includes(agentId))
        .slice(-20)
        .map(diagnosticText),
      truncated: stat.size > length,
    };
  } catch (error) {
    return { lines: [], unavailable: diagnosticText(String(error)) };
  } finally {
    await file?.close();
  }
}
