import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({
  prepareGitWorker: vi.fn(),
  cancelGitWorkerStartup: vi.fn(),
  execInWorker: vi.fn(),
  WorkerDispatchError: class extends Error {},
}));
vi.mock("./run-git-command-worker.js", () => worker);
import { execCommand } from "./spawn.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers();
  worker.prepareGitWorker.mockReset();
  worker.cancelGitWorkerStartup.mockReset();
  worker.execInWorker.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers();
});

describe("short command worker startup", () => {
  it("honors timeout during handshake without starting the command or cancelling shared startup", async () => {
    worker.prepareGitWorker.mockReturnValue(new Promise(() => {}));
    const result = execCommand("example.exe", [], { timeout: 100 });
    const assertion = expect(result).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(worker.execInWorker).not.toHaveBeenCalled();
    expect(worker.cancelGitWorkerStartup).not.toHaveBeenCalled();
  });

  it("aborts immediately during handshake without cancelling shared startup", async () => {
    worker.prepareGitWorker.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const result = execCommand("example.exe", [], { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
    });
    controller.abort();
    await assertion;
    expect(worker.execInWorker).not.toHaveBeenCalled();
    expect(worker.cancelGitWorkerStartup).not.toHaveBeenCalled();
  });

  it("deducts handshake time and retains Windows shell escaping", async () => {
    let ready!: (value: boolean) => void;
    worker.prepareGitWorker.mockReturnValue(
      new Promise<boolean>((resolve) => {
        ready = resolve;
      }),
    );
    worker.execInWorker.mockResolvedValue({ stdout: "ok", stderr: "" });
    const result = execCommand("C:\\Program Files\\tool.cmd", ["hello world", "a&b", "%PATH%"], {
      timeout: 1000,
    });
    await vi.advanceTimersByTimeAsync(300);
    ready(true);
    await expect(result).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(worker.execInWorker).toHaveBeenCalledWith(
      '"C:\\Program Files\\tool.cmd"',
      ['"hello world"', "a^&b", "%PATH%"],
      expect.objectContaining({ shell: true, timeout: 700 }),
    );
  });
});
