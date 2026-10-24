import { describe, expect, it } from "vitest";
import { MasterError } from "../server/types";
import { createWakeQueue } from "../server/wake/queue";
import { deferred, tick } from "./helpers";

describe("wake queue", () => {
  it("runs jobs one at a time, merges duplicates and parks blocked jobs until resume", async () => {
    const order: string[] = [];
    const gate = deferred();
    let blockNext = true;
    const queue = createWakeQueue({
      async run(job) {
        order.push(`start ${job.workspaceId}`);
        if (job.workspaceId === "a") await gate.promise;
        if (job.workspaceId === "b" && blockNext) throw new MasterError("quota", "limit");
        order.push(`end ${job.workspaceId}`);
      },
      onFailure: (_job, error) => (error instanceof MasterError ? "block" : "drop"),
    });
    queue.enqueue({ kind: "task_done", workspaceId: "a" });
    queue.enqueue({ kind: "task_done", workspaceId: "b" });
    queue.enqueue({ kind: "task_done", workspaceId: "b" }); // merged
    await tick();
    expect(order).toEqual(["start a"]);
    expect(queue.snapshot().pending).toHaveLength(1);
    gate.resolve();
    await queue.idle();
    expect(order).toEqual(["start a", "end a", "start b"]);
    expect(queue.snapshot().blocked).toHaveLength(1);
    blockNext = false;
    queue.resume();
    await queue.idle();
    expect(order.slice(-2)).toEqual(["start b", "end b"]);
    expect(queue.snapshot().blocked).toHaveLength(0);
  });

  it("exclusive work waits for the running job and holds back the next one", async () => {
    const order: string[] = [];
    const gate = deferred();
    const queue = createWakeQueue({
      async run(job) {
        order.push(`run ${job.workspaceId}`);
        if (job.workspaceId === "a") await gate.promise;
      },
      onFailure: () => "drop",
    });
    queue.enqueue({ kind: "task_done", workspaceId: "a" });
    queue.enqueue({ kind: "task_done", workspaceId: "b" });
    await tick();
    const exclusive = queue.exclusive(async () => void order.push("exclusive"));
    gate.resolve();
    await exclusive;
    await queue.idle();
    expect(order).toEqual(["run a", "exclusive", "run b"]);
  });
});
