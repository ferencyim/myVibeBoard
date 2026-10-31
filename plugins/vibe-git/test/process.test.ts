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
  it("保留输出、退出错误和缓冲限制", async () => {
    const runner = createProcessRunner();
    try {
      await expect(runner.run(process.execPath, ["-e", "process.stdout.write('ok\\n')"])).resolves.toBe("ok");
      await expect(runner.run(process.execPath, ["-e", "process.stderr.write('reason'); process.exit(7)"]))
        .rejects.toMatchObject({ message: "Process exited with code 7", stderr: "reason" });
      await expect(runner.run(process.execPath, ["-e", "process.stdout.write('12345')"], { maxBuffer: 4 }))
        .rejects.toThrow("Process stdout exceeded maximum buffer");
    } finally {
      await runner.cleanup();
    }
  });

  it("关闭时终止运行中进程并拒绝新请求", async () => {
    const runner = createProcessRunner();
    const pending = runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const cleanup = runner.cleanup();
    await expect(pending).rejects.toThrow("Process terminated");
    await cleanup;
    await expect(runner.run(process.execPath, ["-v"])).rejects.toThrow("Process runner has been closed");
  });

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
      await runner.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});
