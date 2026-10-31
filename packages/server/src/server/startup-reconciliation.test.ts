import { afterEach, expect, test, vi } from "vitest";
import { scheduleStartupReconciliation } from "./startup-reconciliation.js";

afterEach(() => vi.useRealTimers());

test("starts background reconciliation once after 30 seconds", async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  scheduleStartupReconciliation(run);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(1);
});

test("cancelling on shutdown prevents the pending reconciliation", async () => {
  vi.useFakeTimers();
  const run = vi.fn();
  const cancel = scheduleStartupReconciliation(run);
  await vi.advanceTimersByTimeAsync(29_999);
  cancel();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
