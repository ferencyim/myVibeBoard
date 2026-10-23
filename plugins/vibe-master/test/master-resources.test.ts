import { describe, expect, it } from "vitest";
import { createMasterResources } from "../server/subscription/resources";
import { createEventConsumer, publishEvent } from "../server/vibe/db";
import { setupBoard } from "./helpers";

function setup(deny = false, release = true) {
  const board = setupBoard();
  const actions: string[] = [];
  const scheduler = createEventConsumer({
    db: board.db,
    consumer: "test-scheduler",
    types: ["scheduler.task_resource_request"],
    startAt: "now",
    pollIntervalMs: 2,
    handler(event) {
      const p = event.payload;
      actions.push(p.action);
      publishEvent(board.db, {
        type: "scheduler.task_resource_result",
        payload: {
          requestId: p.requestId,
          workspaceId: p.workspaceId,
          ok:
            !(deny && p.action === "acquire") &&
            (!["release", "reconcile"].includes(p.action) || release),
          reason: deny ? "并发已满" : "已登记",
          reservationId: "lease-1",
        },
      });
    },
  });
  scheduler.start();
  const resources = createMasterResources({ db: board.db, log: () => undefined });
  const agent = {
    id: "master-native",
    run: async () => ({ status: "idle" as const, lastMessage: "ok", error: null }),
    refresh: async () => ({ agent: { workspaceId: "native-workspace" } }),
    archive: async () => undefined,
  };
  return {
    ...board,
    actions,
    resources,
    agent,
    stop: async () => {
      await resources.stop();
      await scheduler.stop();
    },
  };
}
const target = { provider: "claude", model: "opus-x", thinking: null };
describe("master auxiliary compute resources", () => {
  it("acquires and binds the real native workspace before running, then releases", async () => {
    const t = setup();
    const release = await t.resources.acquire(t.agent, target);
    expect(t.actions).toEqual(["acquire", "bind"]);
    await release();
    expect(t.actions).toEqual(["acquire", "bind", "release"]);
    await t.stop();
  });
  it("denies running when scheduler admission fails", async () => {
    const t = setup(true);
    await expect(t.resources.acquire(t.agent, target)).rejects.toThrow("并发已满");
    expect(t.actions).toEqual(["acquire"]);
    await t.stop();
  });
  it("keeps an active native turn's lease instead of acquiring another compute slot", async () => {
    const t = setup(false, false);
    const release = await t.resources.acquire(t.agent, target);
    await expect(release()).rejects.toThrow("保留计算租约");
    await expect(t.resources.acquire(t.agent, target)).rejects.toThrow("停止仍未确认");
    expect(t.actions).toEqual(["acquire", "bind", "release", "reconcile"]);
    await t.stop();
  });
  it("holds memory file locks as a host operation without impersonating a native writer", async () => {
    const t = setup();
    const release = await t.resources.acquireFiles(
      "completed-task-workspace",
      [".vibe/**", "PRODUCT-REQUIREMENTS.md"],
      target,
    );
    expect(t.actions).toEqual(["acquire"]);
    await release();
    expect(t.actions).toEqual(["acquire", "release"]);
    await t.stop();
  });
});
