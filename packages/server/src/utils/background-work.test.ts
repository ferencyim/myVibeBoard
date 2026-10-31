import { describe, expect, it, vi } from "vitest";
import { createBackgroundWorkQueue } from "./background-work.js";

describe("background work queue", () => {
  it("bounds background concurrency and does not queue foreground work", async () => {
    const run = createBackgroundWorkQueue(2);
    const releases: Array<() => void> = [];
    const started = vi.fn();
    const work = () => {
      started();
      return new Promise<void>((resolve) => releases.push(resolve));
    };
    const jobs = [run(work), run(work), run(work)];
    await Promise.resolve();
    expect(started).toHaveBeenCalledTimes(2);
    const foreground = vi.fn();
    await Promise.resolve().then(foreground);
    expect(foreground).toHaveBeenCalledOnce();
    releases[0]?.();
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(3));
    releases[1]?.();
    releases[2]?.();
    await Promise.all(jobs);
  });
});
