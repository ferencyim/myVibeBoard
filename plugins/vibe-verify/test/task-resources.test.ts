import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskResources } from "../server/task-resources";
import { readEvidenceBytes } from "../server/rpc";
import {
  createEventConsumer,
  migrateOwner,
  openVibeDb,
  publishEvent,
} from "../server/vibe/db";

describe("验证资源与证据权限", () => {
  it("正常资源争用只排队，资源释放后继续；绑定前失败用reconcile回收", async () => {
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "scheduler");
    let occupied = true;
    let attempts = 0;
    const actions: string[] = [];
    const waiting: string[] = [];
    const scheduler = createEventConsumer({
      db,
      consumer: "test-scheduler",
      types: ["scheduler.task_resource_request"],
      pollIntervalMs: 2,
      startAt: "now",
      handler: (event) => {
        const p = event.payload as { requestId: string; workspaceId: string; action: string };
        actions.push(p.action);
        if (p.action === "acquire") attempts++;
        publishEvent(db, {
          type: "scheduler.task_resource_result",
          payload: {
            requestId: p.requestId,
            workspaceId: p.workspaceId,
            ok: p.action !== "acquire" || !occupied,
            reason: occupied ? "全局并发已满" : "",
            retryable: occupied,
            ...(!occupied ? { reservationId: "resource-1", provider: "codex" } : {}),
          },
        });
      },
    });
    scheduler.start();
    const client = createTaskResources(db, {
      pollMs: 2,
      current: () => ({ phase: "verifying", confirmedAt: "round-1" }),
      waiting: async (_id, reason) => {
        waiting.push(reason);
      },
    });
    try {
      let done = false;
      const pending = client.acquire("ws", "verifier", "codex", 0).then((value) => {
        done = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(done).toBe(false);
      expect(attempts).toBeGreaterThan(0);
      expect(waiting).toEqual(["全局并发已满"]);
      occupied = false;
      const lease = await pending;
      await lease.release();
      expect(actions).toContain("reconcile");
    } finally {
      await client.stop();
      await scheduler.stop();
      db.close();
    }
  });
  it("排队期间用户停止或确认变化就停止请求", async () => {
    const db = openVibeDb({ path: ":memory:" });
    migrateOwner(db, "scheduler");
    let phase = "verifying";
    const scheduler = createEventConsumer({
      db,
      consumer: "test-scheduler",
      types: ["scheduler.task_resource_request"],
      pollIntervalMs: 2,
      startAt: "now",
      handler: (event) => {
        const p = event.payload as { requestId: string; workspaceId: string };
        publishEvent(db, {
          type: "scheduler.task_resource_result",
          payload: { ...p, ok: false, reason: "文件冲突", retryable: true },
        });
      },
    });
    scheduler.start();
    const client = createTaskResources(db, {
      pollMs: 2,
      current: () => ({ phase, confirmedAt: "round-1" }),
      waiting: async () => {
        phase = "paused";
      },
    });
    try {
      await expect(client.acquire("ws", "verifier", "codex", 0)).rejects.toThrow(
        "任务已停止或确认变化",
      );
    } finally {
      await client.stop();
      await scheduler.stop();
      db.close();
    }
  });
  it("证据读取只能访问真实证据根目录中的文件", () => {
    const root = mkdtempSync(join(tmpdir(), "vibe-evidence-access-"));
    const inside = join(root, "report.json");
    writeFileSync(inside, "{}");
    const outside = join(tmpdir(), "vibe-evidence-outside-" + Date.now());
    writeFileSync(outside, "private");
    expect(readEvidenceBytes(inside, root).toString()).toBe("{}");
    expect(() => readEvidenceBytes(outside, root)).toThrow("证据文件不在允许目录内");
  });
});
