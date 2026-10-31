import { describe, expect, it } from "vitest";
import { prepareGitWorker, spawnGitInWorker } from "./run-git-command-worker.js";

function closed(child: ReturnType<typeof spawnGitInWorker>) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: Buffer;
    error?: Error;
  }>((resolve) => {
    const chunks: Buffer[] = [];
    let error: Error | undefined;
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (value: Error) => {
      error = value;
    });
    child.on("close", (code, signal) =>
      resolve({ code, signal, output: Buffer.concat(chunks), error }),
    );
  });
}

describe("Git worker transport", () => {
  it("passes stdin and binary stdout and remains usable after a spawn error", async () => {
    expect(await prepareGitWorker()).toBe(true);
    const failed = spawnGitInWorker(["--version"], {
      cwd: "?:/missing-git-worker-directory",
      hasInput: false,
    });
    expect((await closed(failed)).error).toBeDefined();
    const child = spawnGitInWorker(["hash-object", "--stdin"], {
      cwd: process.cwd(),
      hasInput: true,
    });
    const result = closed(child);
    child.stdin!.end("");
    const completed = await result;
    expect(completed.code).toBe(0);
    expect(completed.output.toString().trim()).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("terminates a process waiting for stdin", async () => {
    expect(await prepareGitWorker()).toBe(true);
    const child = spawnGitInWorker(["hash-object", "--stdin"], {
      cwd: process.cwd(),
      hasInput: true,
    });
    const result = closed(child);
    child.kill("SIGKILL");
    expect((await result).code).not.toBe(0);
  });
});
