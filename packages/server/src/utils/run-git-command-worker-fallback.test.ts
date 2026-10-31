import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function finishChild(child: EventEmitter) {
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
}

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
  vi.doUnmock("node:worker_threads");
  vi.doUnmock("./spawn.js");
  vi.resetModules();
});

describe("Git worker startup failure", () => {
  it("disables the worker and warns once when its constructor throws", async () => {
    const construct = vi.fn(function () {
      throw new Error("worker constructor failed");
    });
    vi.doMock("node:worker_threads", () => ({ Worker: construct }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prepareGitWorker } = await import("./run-git-command-worker.js");

    expect(await prepareGitWorker()).toBe(false);
    expect(await prepareGitWorker()).toBe(false);
    expect(construct).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("times out while waiting for readiness without starting a Git command", async () => {
    const postMessage = vi.fn();
    const events = new EventEmitter();
    const terminate = vi.fn(async () => 0);
    class PendingWorker {
      postMessage = postMessage;
      on(type: string, listener: (...args: never[]) => void) {
        events.on(type, listener);
        return this;
      }
      ref() {
        return this;
      }
      unref() {
        return this;
      }
      terminate = terminate;
    }
    vi.doMock("node:worker_threads", () => ({ Worker: PendingWorker }));
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: null;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = null;
      child.kill = () => true;
      queueMicrotask(finishChild.bind(null, child));
      return child;
    });
    vi.doMock("./spawn.js", () => ({ spawnProcess: spawn }));
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runGitCommand } = await import("./run-git-command.js");

    await expect(runGitCommand(["status"], { cwd: process.cwd(), timeout: 20 })).rejects.toThrow(
      "超时",
    );
    events.emit("message", { type: "ready" });
    await expect(runGitCommand(["status"], { cwd: process.cwd() })).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(postMessage).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls back once startup fails asynchronously, without sending a command to the worker", async () => {
    const postMessage = vi.fn();
    class FailedWorker extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit("error", new Error("cannot load worker")));
      }
      postMessage = postMessage;
      ref() {
        return this;
      }
      unref() {
        return this;
      }
    }
    vi.doMock("node:worker_threads", () => ({ Worker: FailedWorker }));
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: null;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = null;
      child.kill = () => true;
      queueMicrotask(finishChild.bind(null, child));
      return child;
    });
    vi.doMock("./spawn.js", () => ({ spawnProcess: spawn }));
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runGitCommand } = await import("./run-git-command.js");

    await runGitCommand(["status"], { cwd: process.cwd() });
    await runGitCommand(["status"], { cwd: process.cwd() });

    expect(postMessage).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not replay a command after the ready worker has accepted it", async () => {
    const postMessage = vi.fn();
    class CrashedWorker extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit("message", { type: "ready" }));
      }
      postMessage(message: unknown) {
        postMessage(message);
        queueMicrotask(() => this.emit("error", new Error("worker crashed")));
      }
      ref() {
        return this;
      }
      unref() {
        return this;
      }
    }
    vi.doMock("node:worker_threads", () => ({ Worker: CrashedWorker }));
    const spawn = vi.fn();
    vi.doMock("./spawn.js", () => ({ spawnProcess: spawn }));
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runGitCommand } = await import("./run-git-command.js");

    await expect(
      runGitCommand(["commit", "--allow-empty"], { cwd: process.cwd() }),
    ).rejects.toThrow("worker crashed");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
