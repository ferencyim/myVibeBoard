import { describe, expect, it } from "vitest";
import { AgentSessionSchema } from "../contract/model";
import { StateMachineError } from "../contract/state-machine";
import { readEvents } from "../db";
import { createResourceSampleCommands } from "../db/resource-samples";
import { setup } from "./helpers";

function seedProject(s: ReturnType<typeof setup>) {
  return s.store.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath: "<repo>",
    projectType: "web",
  });
}

const types = (s: ReturnType<typeof setup>) =>
  readEvents(s.db, 0, { limit: 1000 }).map((e) => e.type);

describe("presets", () => {
  it("round-trips presets and enforces unique names", () => {
    const s = setup();
    const p = s.store.presets.create({
      name: "Claude Opus",
      provider: "claude",
      model: "opus",
      thinking: "high",
      permissionMode: "auto",
      environmentKind: "new-worktree",
      baseBranch: "main",
      runtimeEnv: "android-emulator",
    });
    expect(p).toMatchObject({
      permissionMode: "auto",
      runtimeEnv: "android-emulator",
      builtin: false,
    });
    expect(() =>
      s.store.presets.create({ name: "claude opus", provider: "x", model: "y" }),
    ).toThrow(/already exists/);
    expect(s.store.presets.update(p.id, { thinking: "max" }).thinking).toBe("max");
    expect(s.store.presets.list()).toHaveLength(1);
  });
});

describe("agent sessions", () => {
  function started() {
    const s = setup();
    const p = seedProject(s);
    const session = s.store.sessions.start({
      projectId: p.id,
      workspaceId: "workspace",
      agentId: "agent-1",
      provider: "claude",
      role: "worker",
    });
    return { s, session };
  }

  it("tracks waiting_since / pending question and emits waiting/answered", () => {
    const { s, session } = started();
    s.store.sessions.setState(session.id, "working");
    s.tick(5000);
    const waiting = s.store.sessions.setState(session.id, "waiting", {
      question: { text: "which db?" },
    });
    expect(waiting).toMatchObject({ state: "waiting", pendingQuestion: { text: "which db?" } });
    expect(waiting.waitingSince).toBe(new Date(s.clock.ms).toISOString());
    // re-asserting waiting keeps the original waiting_since
    s.tick(5000);
    expect(s.store.sessions.setState(session.id, "waiting").waitingSince).toBe(
      waiting.waitingSince,
    );

    const answered = s.store.sessions.setState(session.id, "working");
    expect(answered).toMatchObject({ waitingSince: null, pendingQuestion: null });
    expect(types(s).filter((t) => t.startsWith("session."))).toEqual([
      "session.started",
      "session.waiting",
      "session.answered",
    ]);
  });

  it("validates session transitions and handles end/error", () => {
    const { s, session } = started();
    s.store.sessions.setState(session.id, "working");
    const err = s.store.sessions.setState(session.id, "error", { message: "rate limit" });
    expect(err).toMatchObject({ state: "error", errorMessage: "rate limit" });
    expect(s.store.sessions.setState(session.id, "working").errorMessage).toBeNull();
    const ended = s.store.sessions.setState(session.id, "ended", { outcome: "completed" });
    expect(ended.endedAt).not.toBeNull();
    expect(() => s.store.sessions.setState(session.id, "working")).toThrow(StateMachineError);
    expect(types(s)).toEqual(expect.arrayContaining(["session.error", "session.ended"]));
    expect(AgentSessionSchema.parse(JSON.parse(JSON.stringify(ended)))).toMatchObject({
      id: session.id,
    });
  });

  it("records provider switches, compactions and cache expiry", () => {
    const { s, session } = started();
    const sw = s.store.sessions.switchProvider(session.id, "codex", "quota low");
    expect(sw.currentProvider).toBe("codex");
    expect(sw.switchHistory).toMatchObject([{ from: "claude", to: "codex", reason: "quota low" }]);
    expect(s.store.sessions.switchProvider(session.id, "codex").switchHistory).toHaveLength(1);
    s.store.sessions.recordCompaction(session.id, "compact");
    const touched = s.store.sessions.touch(session.id, {
      cacheExpiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(touched.cacheExpiresAt).toBe("2026-01-01T01:00:00.000Z");
    expect(types(s)).toEqual(expect.arrayContaining(["session.switched", "session.compacted"]));
  });

  it("one session per Paseo agent; the master session has no card", () => {
    const { s } = started();
    expect(() =>
      s.store.sessions.start({
        cardId: null,
        agentId: "agent-1",
        role: "master",
        provider: "claude",
      }),
    ).toThrow(/already has a session/);
    const master = s.store.sessions.start({
      cardId: null,
      agentId: "agent-m",
      role: "master",
      provider: "claude",
    });
    expect(master.cardId).toBeNull();
    expect(s.store.sessions.getByAgent("agent-m")?.id).toBe(master.id);
    expect(s.store.sessions.list({ role: "master" })).toHaveLength(1);
  });

  it("retains the project and workspace when replacing a native session", () => {
    const { s, session } = started();
    const next = s.store.sessions.recordReassign({
      fromSessionId: session.id,
      agentId: "replacement",
      provider: "codex",
      workspaceId: session.workspaceId,
      reason: "切换接手者",
    });
    expect(next.to).toMatchObject({
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      cardId: null,
    });
    expect(
      readEvents(s.db, 0).findLast((event) => event.type === "session.reassigned"),
    ).toMatchObject({ projectId: session.projectId, cardId: null });
    s.db.close();
  });
});

describe("resource sample commands", () => {
  it("records attribution JSON and prunes only samples before the cutoff", () => {
    const { db } = setup();
    const commands = createResourceSampleCommands(db);
    const sample = {
      cpu: 0.2,
      mem: 0.3,
      perSession: { session: { bytes: 12 } },
      devicePool: { device: "空闲" },
    };
    commands.record({ ...sample, ts: "2026-10-23T10:00:00.000Z" });
    commands.record({ ...sample, ts: "2026-10-23T11:00:00.000Z" });
    expect(commands.prune("2026-10-23T11:00:00.000Z")).toBe(1);
    expect(
      db.prepare("SELECT ts,per_session_json,device_pool_json FROM resource_sample").all(),
    ).toEqual([
      {
        ts: "2026-10-23T11:00:00.000Z",
        per_session_json: JSON.stringify(sample.perSession),
        device_pool_json: JSON.stringify(sample.devicePool),
      },
    ]);
    db.close();
  });
});
