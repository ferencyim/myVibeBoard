import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRunner } from "../server/process";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("子进程生命周期", () => {
  it("超时时终止父进程及其子进程", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-git-process-"));
    const pidFile = path.join(dir, "pids.json");
    const runner = createProcessRunner();
    const script = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore"
      });
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    try {
      await expect(runner.run(process.execPath, ["-e", script, pidFile], {
        timeoutMs: 2000,
      })).rejects.toThrow(/timed out/);
      const pids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
      expect(pids).toHaveLength(2);
      expect(pids.every((pid) => !isRunning(pid))).toBe(true);
    } finally {
      runner.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
