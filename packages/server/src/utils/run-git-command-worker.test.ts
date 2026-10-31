import { describe, expect, it } from "vitest";
import { execInWorker, prepareGitWorker, spawnGitInWorker } from "./run-git-command-worker.js";

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

describe("short command worker", () => {
  it("preserves output and command failure details", async () => {
    expect(await prepareGitWorker()).toBe(true);
    const options = { env: process.env, encoding: "utf8" as const, shell: false };
    await expect(
      execInWorker(
        process.execPath,
        ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
        options,
      ),
    ).resolves.toEqual({ stdout: "out", stderr: "err" });
    await expect(
      execInWorker(
        process.execPath,
        ["-e", "process.stderr.write('failure'); process.exit(7)"],
        options,
      ),
    ).rejects.toMatchObject({ code: 7, stderr: "failure" });
  });

  it("enforces timeouts and aborts without affecting subsequent commands", async () => {
    expect(await prepareGitWorker()).toBe(true);
    const options = { env: process.env, encoding: "utf8" as const, shell: false };
    await expect(
      execInWorker(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        ...options,
        timeout: 100,
      }),
    ).rejects.toMatchObject({ killed: true });
    const controller = new AbortController();
    const pending = execInWorker(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      ...options,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    await expect(
      execInWorker(process.execPath, ["-e", "process.stdout.write('ok')"], options),
    ).resolves.toMatchObject({ stdout: "ok" });
  });
});

it("does not terminate the shared worker when execFile rejects invalid options synchronously", async () => {
  expect(await prepareGitWorker()).toBe(true);
  const options = { env: process.env, encoding: "utf8" as const, shell: false };
  await expect(
    execInWorker(process.execPath, [], { ...options, maxBuffer: -1 }),
  ).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
  await expect(
    execInWorker(process.execPath, ["-e", "process.stdout.write('alive')"], options),
  ).resolves.toMatchObject({ stdout: "alive" });
});
