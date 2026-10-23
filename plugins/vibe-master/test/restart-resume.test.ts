// WP-103: after a daemon restart the master agent is closed; the next wake resumes it instead of
// starting a new "Vibe Master".

import { describe, expect, it } from "vitest";
import { createMasterRuntime } from "../server/runtime";
import { askMaster, ManualClock, defaultSettings, fakePaseo, setupBoard, tempDir } from "./helpers";

function build(fakeOptions: Parameters<typeof fakePaseo>[1] = {}) {
  const board = setupBoard();
  const fake = fakePaseo(() => "ok", fakeOptions);
  const settings = defaultSettings({ provider: "claude", permissionMode: "auto" });
  const dataDir = tempDir();
  const clock = new ManualClock();
  const start = () =>
    createMasterRuntime({
      admitMaster: async () => async () => undefined,
      admitMemory: async () => async () => undefined,
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => settings,
      dataDir,
      clock,
      pollIntervalMs: 3_600_000,
      log: () => undefined,
    });
  return { board, fake, settings, start };
}

async function wake(
  t: ReturnType<typeof build>,
  runtime: ReturnType<typeof build>["start"] extends () => infer R ? R : never,
  _title: string,
) {
  await askMaster(runtime);
  await runtime.queue.idle();
}

/** The daemon stops: every agent is closed (the board keeps the master session, see vibe-board lifecycle). */
const closeAll = (t: ReturnType<typeof build>) => t.fake.agents.forEach((a) => (a.closed = true));

describe("master agent after a daemon restart", () => {
  it("resumes the closed agent and keeps the session", async () => {
    const t = build();
    const first = t.start();
    await wake(t, first, "A");
    await first.dispose();
    closeAll(t);

    const second = t.start();
    await wake(t, second, "B");
    expect(t.fake.agents).toHaveLength(1);
    expect(t.fake.agents[0]).toMatchObject({ closed: false, resumes: 1 });
    expect(t.fake.agents[0]!.prompts).toHaveLength(2);
    expect(t.board.store.sessions.list({ role: "master" })).toHaveLength(1);
    await second.dispose();
  });

  it("does not resume an agent that is loaded", async () => {
    const t = build();
    const first = t.start();
    await wake(t, first, "A");
    await first.dispose();
    const second = t.start();
    await wake(t, second, "B");
    expect(t.fake.agents[0]!.resumes ?? 0).toBe(0);
    await second.dispose();
  });

  it("starts a new agent with the hand-off summary when the resume fails", async () => {
    const t = build({ failResume: true });
    const first = t.start();
    await wake(t, first, "A");
    await first.dispose();
    closeAll(t);

    const second = t.start();
    await wake(t, second, "B");
    expect(t.fake.agents).toHaveLength(2);
    expect(t.fake.agents[1]!.prompts[0]).toContain("restart_recovery_failed");
    const sessions = t.board.store.sessions.list({ role: "master" });
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ state: "ended" });
    expect(second.sessions().find((s) => s.agentId === "agent-1")?.retiredReason).toBe(
      "restart_recovery_failed",
    );
    await second.dispose();
  });

  it("still starts a new agent when the permission mode changed meanwhile", async () => {
    const t = build();
    const first = t.start();
    await wake(t, first, "A");
    await first.dispose();
    closeAll(t);
    t.settings.permissionMode = "acceptEdits";

    const second = t.start();
    await wake(t, second, "B");
    expect(t.fake.agents).toHaveLength(2);
    expect(t.fake.agents[0]!.resumes ?? 0).toBe(0);
    expect(second.sessions().find((s) => s.agentId === "agent-1")?.retiredReason).toBe("replaced");
    await second.dispose();
  });

  it("keeps using the agent on a host without resume()", async () => {
    const t = build({ noResume: true });
    const first = t.start();
    await wake(t, first, "A");
    await first.dispose();
    closeAll(t);

    const second = t.start();
    await wake(t, second, "B");
    expect(t.fake.agents).toHaveLength(1);
    await second.dispose();
  });
});
