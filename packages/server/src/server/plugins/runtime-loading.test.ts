import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { PluginRuntime } from "./runtime.js";

describe("plugin calls during startup", () => {
  it("waits for a queued plugin and invokes it after it becomes ready", async () => {
    const runtime = new PluginRuntime(pino({ enabled: false }), "1.0.0");
    const finish = runtime.markPluginLoading("target");
    const pending = runtime.invoke("target", "run", { value: 1 });
    const request = vi.fn().mockResolvedValue("ok");
    const internals = runtime as unknown as {
      plugins: Map<string, unknown>;
      request: typeof request;
    };
    internals.request = request;
    internals.plugins.set("target", { methods: new Set(["run"]) });
    finish();
    await expect(pending).resolves.toBe("ok");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]).toMatchObject({ method: "run", input: { value: 1 } });
  });

  it("fails immediately for unavailable plugins and wakes when a load fails or is stopped", async () => {
    const runtime = new PluginRuntime(pino({ enabled: false }), "1.0.0");
    await expect(runtime.invoke("missing", "run", {})).rejects.toThrow("Plugin is not available");
    const finishFailed = runtime.markPluginLoading("failed");
    const failed = runtime.invoke("failed", "run", {});
    finishFailed();
    await expect(failed).rejects.toThrow("Plugin is not available: failed");
    const finishStopped = runtime.markPluginLoading("stopped");
    const stopped = runtime.invoke("stopped", "run", {});
    await runtime.stopPluginById("stopped");
    await expect(stopped).rejects.toThrow("Plugin is not available: stopped");
    finishStopped();
  });

  it("times out a stuck load without dispatching the request", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new PluginRuntime(pino({ enabled: false }), "1.0.0");
      const finish = runtime.markPluginLoading("stuck");
      const pending = runtime.invoke("stuck", "run", {});
      const expectation = expect(pending).rejects.toThrow("Plugin loading timed out: stuck");
      await vi.advanceTimersByTimeAsync(25_000);
      await expectation;
      finish();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
