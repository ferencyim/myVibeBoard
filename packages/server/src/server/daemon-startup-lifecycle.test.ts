import { describe, expect, test, vi } from "vitest";
import { stopDaemonAfterStartup } from "./daemon-startup-lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("shutdown during startup", () => {
  test("waits for initialization and then stops the created daemon", async () => {
    const initialization = deferred<{ stop: () => Promise<void> }>();
    const stop = vi.fn(async () => {});
    const shutdown = stopDaemonAfterStartup(initialization.promise, () => null);
    expect(stop).not.toHaveBeenCalled();
    initialization.resolve({ stop });
    await shutdown;
    expect(stop).toHaveBeenCalledOnce();
  });

  test("waits for a pending start, and stops even if start fails", async () => {
    const start = deferred<void>();
    const stop = vi.fn(async () => {});
    const shutdown = stopDaemonAfterStartup(Promise.resolve({ stop }), () => start.promise);
    await Promise.resolve();
    expect(stop).not.toHaveBeenCalled();
    start.reject(new Error("listen failed"));
    await shutdown;
    expect(stop).toHaveBeenCalledOnce();
  });
});
