import { describe, expect, it, vi } from "vitest";
import { createRetryErrorLogger } from "../server/retry-log";

describe("scheduler retry logging", () => {
  it("logs distinct error messages without stacks at most once per minute", () => {
    let time = 0;
    const write = vi.fn();
    const log = createRetryErrorLogger(write, () => time);
    const error = new Error("Plugin is not available: vibe-bots");
    log(error);
    time = 5_000;
    log(error);
    log(new Error("another failure"));
    expect(write.mock.calls).toEqual([
      ["vibe-scheduler: Plugin is not available: vibe-bots"],
      ["vibe-scheduler: another failure"],
    ]);
    time = 60_000;
    log(error);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenLastCalledWith("vibe-scheduler: Plugin is not available: vibe-bots");
  });
});
