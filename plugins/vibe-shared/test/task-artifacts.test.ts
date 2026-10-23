import { describe, expect, it } from "vitest";
import { TaskRoleSnapshotSchema } from "../contract/model-roles";
import { createVibeStore, openVibeDb, readEvents } from "../db";
import { setup } from "./helpers";

const source = {
  conversationId: "conversation",
  sourceKey: "planner:turn",
  memberId: "planner",
  backendAgentId: "backend",
  epoch: "epoch",
  seq: 3,
};
const plan = {
  goal: "目标",
  approach: "做法",
  files: [],
  subtasks: [],
  checks: [{ text: "结果", method: "单测" }],
};
const preset = {
  presetId: "p",
  source: "global",
  models: [{ provider: "codex", model: "test", thinking: "", permissionMode: "auto" }],
  environmentKind: "project-default",
  runtimeEnv: null,
  instructions: "中文",
};
const roles = TaskRoleSnapshotSchema.parse({
  scout: null,
  planner: preset,
  plan_reviewer: null,
  worker: preset,
  subagent: preset,
  reviewer: null,
  verifier: preset,
});
function fixture() {
  const state = setup();
  state.store.tasks.create({
    workspaceId: "workspace",
    anchorAgentId: "backend",
    conversationId: "conversation",
  });
  return state;
}

describe("WP-115 conversation binding and confirmation", () => {
  it("reconciles a rejected initial anchor while preserving the plan, source and historical artifacts", () => {
    const s = fixture();
    s.store.tasks.savePlan("workspace", plan);
    s.store.tasks.setPlanSource("workspace", source);
    const artifact = s.store.taskArtifacts.record({
      workspaceId: "workspace",
      kind: "plan",
      sourceKey: "plan:before-reconcile",
      source,
      summary: "保留方案",
      data: { plan },
    });
    const before = s.store.tasks.get("workspace")!;
    const events = readEvents(s.db, 0).length;
    const updated = s.store.tasks.reconcileInitialAnchor("workspace", {
      conversationId: "conversation",
      expectedAnchorAgentId: "backend",
      anchorAgentId: "canonical-backend",
    });
    expect(updated).toEqual({ ...before, anchorAgentId: "canonical-backend" });
    expect(s.store.taskArtifacts.list("workspace")).toEqual([artifact]);
    expect(readEvents(s.db, 0)).toHaveLength(events + 1);
    expect(readEvents(s.db, 0).at(-1)?.payload).toEqual({
      workspaceId: "workspace",
      fields: ["anchorAgentId"],
    });
    expect(
      s.store.tasks.reconcileInitialAnchor("workspace", {
        conversationId: "conversation",
        expectedAnchorAgentId: "canonical-backend",
        anchorAgentId: "canonical-backend",
      }),
    ).toEqual(updated);
    expect(readEvents(s.db, 0)).toHaveLength(events + 1);
    s.db.close();
  });
  it("rejects a stale anchor CAS from another connection and refuses confirmed or unrelated conversations", () => {
    const s = fixture();
    const otherDb = openVibeDb({ path: s.path });
    const other = createVibeStore(otherDb);
    const input = {
      conversationId: "conversation",
      expectedAnchorAgentId: "backend",
      anchorAgentId: "canonical-backend",
    };
    expect(() =>
      s.store.tasks.reconcileInitialAnchor("workspace", {
        ...input,
        conversationId: "other-conversation",
      }),
    ).toThrow(/会话不一致/);
    s.store.tasks.reconcileInitialAnchor("workspace", input);
    expect(() =>
      other.tasks.reconcileInitialAnchor("workspace", {
        ...input,
        anchorAgentId: "stale-competitor",
      }),
    ).toThrow(/已变化/);
    s.store.tasks.confirm("workspace", {
      plan,
      rolesSnapshot: roles,
      planSource: { ...source, backendAgentId: "canonical-backend" },
      requestId: "execute-after-reconcile",
    });
    expect(() =>
      s.store.tasks.reconcileInitialAnchor("workspace", {
        ...input,
        expectedAnchorAgentId: "canonical-backend",
        anchorAgentId: "post-confirm-change",
      }),
    ).toThrow(/仅未确认/);
    expect(s.store.tasks.get("workspace")?.anchorAgentId).toBe("canonical-backend");
    otherDb.close();
    s.db.close();
  });
  it("retains consumed action identities across replanning and plan replacement", () => {
    const s = fixture();
    const retained = {
      completedRequestIds: ["execute-old"],
      handledAcceptanceSource: "human:old",
      startedCommandRequests: ["pending"],
    };
    s.store.tasks.setControl("workspace", {
      ...retained,
      verifiedCommit: "old-commit",
      git: { pushed: true },
    });
    s.store.tasks.savePlan("workspace", plan);
    expect(s.store.tasks.get("workspace")?.control).toEqual(retained);
    s.store.tasks.updateControl("workspace", { currentStep: "plan_review" });
    s.store.tasks.setPhase("workspace", "planning");
    expect(s.store.tasks.get("workspace")?.control).toEqual(retained);
    s.db.close();
  });
  it("binds once, enforces unique ownership and persists task selections without rewriting frozen roles", () => {
    const s = fixture();
    const events = readEvents(s.db, 0).length;
    expect(s.store.tasks.bindConversation("workspace", "conversation").conversationId).toBe(
      "conversation",
    );
    expect(readEvents(s.db, 0)).toHaveLength(events);
    expect(() => s.store.tasks.bindConversation("workspace", "other")).toThrow(/已绑定/);
    s.store.tasks.create({ workspaceId: "second", anchorAgentId: "second" });
    expect(() => s.store.tasks.bindConversation("second", "conversation")).toThrow(/已绑定/);
    s.store.tasks.setPlanSource("workspace", source);
    const queued = s.store.tasks.confirm("workspace", {
      plan,
      rolesSnapshot: roles,
      planSource: source,
      requestId: "execute-1",
    });
    s.store.tasks.setRoleSelections("workspace", { worker: { mode: "preset", presetId: "new" } });
    expect(s.store.tasks.get("workspace")?.rolesSnapshot).toEqual(queued.rolesSnapshot);
    expect(s.store.tasks.get("workspace")?.roleSelections?.worker).toEqual({
      mode: "preset",
      presetId: "new",
    });
    s.db.close();
  });
  it("rejects missing or changed sources, and repeats the same confirmation without a second event", () => {
    const s = fixture();
    expect(() => s.store.tasks.confirm("workspace", { plan, rolesSnapshot: roles })).toThrow(
      /来源/,
    );
    s.store.tasks.setPlanSource("workspace", source);
    expect(() =>
      s.store.tasks.confirm("workspace", {
        plan,
        rolesSnapshot: roles,
        planSource: { ...source, sourceKey: "old" },
      }),
    ).toThrow(/已变化/);
    const input = { plan, rolesSnapshot: roles, planSource: source, requestId: "execute-1" };
    const queued = s.store.tasks.confirm("workspace", input);
    const events = readEvents(s.db, 0).length;
    s.tick();
    expect(s.store.tasks.confirm("workspace", input)).toEqual(queued);
    expect(readEvents(s.db, 0)).toHaveLength(events);
    expect(() =>
      s.store.tasks.confirm("workspace", { ...input, planSource: { ...source, seq: 4 } }),
    ).toThrow(/不一致/);
    expect(() => s.store.tasks.confirm("workspace", { ...input, requestId: "execute-2" })).toThrow(
      /重复确认/,
    );
    s.store.tasks.setPhase("workspace", "paused");
    s.store.tasks.setPhase("workspace", "planning");
    expect(s.store.tasks.get("workspace")).toMatchObject({
      confirmedAt: null,
      planSource: null,
      control: null,
    });
    s.db.close();
  });
});

describe("WP-115 durable artifact commands", () => {
  it("keeps old steps, deduplicates, and discovers unpublished indexes after restart", () => {
    const s = fixture();
    const artifact = {
      workspaceId: "workspace",
      kind: "plan" as const,
      sourceKey: "plan:1",
      source,
      summary: "第一版方案",
      data: { plan },
    };
    const saved = s.store.taskArtifacts.record(artifact);
    const events = readEvents(s.db, 0).length;
    expect(s.store.taskArtifacts.record(artifact)).toEqual(saved);
    expect(readEvents(s.db, 0)).toHaveLength(events);
    expect(() => s.store.taskArtifacts.record({ ...artifact, summary: "覆盖" })).toThrow(
      /不可改写/,
    );
    s.tick();
    s.store.taskArtifacts.record({
      ...artifact,
      sourceKey: "plan:2",
      source: { ...source, sourceKey: "planner:next", seq: 5 },
      summary: "修改方案",
    });
    s.store.tasks.setPhase("workspace", "paused");
    s.store.tasks.setPhase("workspace", "planning");
    s.db.close();
    const db = openVibeDb({ path: s.path });
    const store = createVibeStore(db);
    expect(store.taskArtifacts.list("workspace").map((a) => a.summary)).toEqual([
      "第一版方案",
      "修改方案",
    ]);
    expect(store.taskArtifacts.pendingPublish()).toHaveLength(2);
    store.taskArtifacts.markPublished("workspace", "plan", "plan:1", { epoch: "epoch", seq: 6 });
    store.taskArtifacts.markPublished("workspace", "plan", "plan:1", { epoch: "epoch", seq: 6 });
    expect(() =>
      store.taskArtifacts.markPublished("workspace", "plan", "plan:1", { epoch: "epoch", seq: 7 }),
    ).toThrow(/其它/);
    expect(store.taskArtifacts.pendingPublish("workspace")).toHaveLength(1);
    expect(store.taskArtifacts.list("workspace", { confirmedAt: null })).toHaveLength(2);
    db.close();
  });
  it("commits milestone phase/control with its index and rolls everything back on event failure", () => {
    const s = fixture();
    s.store.tasks.confirm("workspace", {
      plan,
      rolesSnapshot: roles,
      planSource: source,
      requestId: "execute",
    });
    const artifact = {
      workspaceId: "workspace",
      kind: "delivery" as const,
      sourceKey: "delivery:1",
      confirmedAt: s.store.tasks.get("workspace")!.confirmedAt,
      source,
      summary: "交付",
      phase: "executing" as const,
      control: { currentStep: "delivery" },
    };
    s.db.exec(
      "CREATE TRIGGER fail_artifact_bus BEFORE INSERT ON vibe_event WHEN NEW.type = 'task.updated' BEGIN SELECT RAISE(ABORT, '模拟落盘失败'); END",
    );
    expect(() => s.store.taskArtifacts.record(artifact)).toThrow(/模拟落盘失败/);
    expect(s.store.taskArtifacts.list("workspace")).toEqual([]);
    expect(s.store.tasks.get("workspace")?.phase).toBe("queued");
    s.db.exec("DROP TRIGGER fail_artifact_bus");
    s.store.taskArtifacts.record(artifact);
    expect(s.store.tasks.get("workspace")).toMatchObject({
      phase: "executing",
      control: { currentStep: "delivery" },
    });
    expect(() =>
      s.store.taskArtifacts.record({
        ...artifact,
        sourceKey: "wrong",
        confirmedAt: "2025-01-01T00:00:00.000Z",
      }),
    ).toThrow(/确认已变化/);
    expect(() =>
      s.store.taskArtifacts.record({
        ...artifact,
        sourceKey: "wrong",
        source: { ...source, conversationId: "other" },
      }),
    ).toThrow(/会话不一致/);
    s.db.close();
  });
});
