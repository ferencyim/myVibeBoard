import { afterEach, expect, it, vi } from "vitest";
import { deferStartup } from "../db/startup";

afterEach(() => vi.useRealTimers());

it("defers recovery beyond ready microtasks and gates requests until it finishes", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const initialize = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const startup = deferStartup(initialize, vi.fn());
  const handler = vi.fn(() => "ready");
  const response = startup.wrap(handler)();
  await Promise.resolve(); // The host reports ready after contribution returns.
  expect(initialize).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(initialize).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
  finish();
  await expect(response).resolves.toBe("ready");
  await startup.close();
});

it("cancels unstarted work on unload and rejects waiting requests", async () => {
  vi.useFakeTimers();
  const initialize = vi.fn();
  const startup = deferStartup(initialize, vi.fn());
  const handler = vi.fn();
  const response = startup.wrap(handler)();
  const rejected = expect(response).rejects.toThrow("插件已停止");
  await startup.close();
  await vi.runAllTimersAsync();
  await rejected;
  expect(initialize).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});

it("reports a failed background initialization and rejects dependent requests", async () => {
  vi.useFakeTimers();
  const error = new Error("recovery failed");
  const log = vi.fn();
  const startup = deferStartup(() => {
    throw error;
  }, log);
  const handler = vi.fn();
  const rejected = expect(startup.wrap(handler)()).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(0);
  await rejected;
  expect(log).toHaveBeenCalledWith(error);
  expect(handler).not.toHaveBeenCalled();
  await startup.close();
});

it("waits for already-started recovery before closing its dependencies", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const startup = deferStartup(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    vi.fn(),
  );
  await vi.advanceTimersByTimeAsync(0);
  let closed = false;
  const closing = startup.close().then(() => {
    closed = true;
    return undefined;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await closing;
  expect(closed).toBe(true);
});
