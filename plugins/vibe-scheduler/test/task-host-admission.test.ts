import { afterEach, describe, expect, it } from "vitest";
import {
  createDeviceLeases,
  createTaskRuntimeCommands,
  createVibeStore,
  migrateOwner,
  openVibeDb,
} from "../server/vibe/db";
import { resolveTaskRoles, TaskPresetSnapshotSchema, type TaskRoleSnapshot } from "../server/vibe/contract";
import { createTaskScheduler, type NativeAgentState } from "../server/task-scheduler";
import { createPortAllocator } from "../server/ports";
import { DEFAULT_CONFIG } from "../server/scheduler";

function confirmTask(store: ReturnType<typeof createVibeStore>, id: string, roles: TaskRoleSnapshot) {
  const task = store.tasks.get(id)!;
  const tab =
    task.tabs.find((item) => item.agentId === task.anchorAgentId) ??
    store.tasks.allocateTab(id, {
      agentId: task.anchorAgentId,
      role: "main",
      provider: "codex",
      model: "cheap",
    }).tab;
  return store.tasks.confirm(id, {
    rolesSnapshot: roles,
    planSource: { tabNumber: tab.number, agentId: tab.agentId, sourceKey: "test-" + id },
  });
}
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
function setup(hubGate?: () => string | null) {
  const db = openVibeDb({ path: ":memory:" });
  closes.push(() => db.close());
  migrateOwner(db, "scheduler");
  const store = createVibeStore(db);
  const preset = store.presets.create({ name: "默认", provider: "codex", model: "cheap" });
  const roles = resolveTaskRoles(
    {},
    null,
    { planner: preset.id, worker: preset.id, verifier: preset.id },
    store.presets.get,
  );
  store.tasks.create({ workspaceId: "workspace", anchorAgentId: "anchor" });
  store.tasks.savePlan("workspace", {
    goal: "目标",
    approach: "做法",
    files: ["src/target.ts"],
    subtasks: [],
    checks: [{ text: "检查", method: "单测" }],
  });
  confirmTask(store, "workspace", roles);
  const runtime = createTaskRuntimeCommands(db);
  const agents: NativeAgentState[] = [];
  const scheduler = createTaskScheduler({
    store,
    leases: createDeviceLeases(db),
    ports: createPortAllocator({ base: 17516, span: 10, isFree: async () => true }),
    config: () => ({ ...DEFAULT_CONFIG, globalLimit: 5 }),
    now: () => new Date(),
    memory: () => 0.1,
    quota: () => ({}),
    identity: async (directory) => ({
      directory: directory.toLowerCase(),
      repo: "same-repository",
    }),
    native: async () => ({
      workspaceId: "workspace",
      projectId: "project",
      directory: process.cwd(),
      archived: false,
      agents,
    }),
    emit: () => undefined,
    hubGate,
  });
  return { db, store, runtime, scheduler, agents };
}
describe("task host admission", () => {
  it("keeps a new task queued with the hub's reason, then admits once the gate opens", async () => {
    let reason: string | null = "中枢：暂停（agents）：维护窗口";
    const ctx = setup(() => reason);
    const request = {
      requestId: "gate",
      workspaceId: "workspace",
      action: "acquire" as const,
      role: "worker" as const,
    };
    const blocked = await ctx.scheduler.requestResource(request);
    expect(blocked).toMatchObject({ ok: false, retryable: true });
    expect(blocked.reason).toContain("维护窗口");
    expect((await ctx.scheduler.tick()).deferred.workspace).toContain("维护窗口");
    reason = null;
    expect((await ctx.scheduler.requestResource(request)).ok).toBe(true);
  });

  it.each(["idle", "running", "active_turn"] as const)(
    "releases an unbound reservation only when every native member is stopped: %s",
    async (state) => {
      const ctx = setup();
      ctx.agents.push({
        id: "existing",
        workspaceId: "workspace",
        cwd: process.cwd(),
        provider: "codex",
        model: "cheap",
        status: "idle",
      });
      const acquired = await ctx.scheduler.requestResource({
        requestId: "acquire",
        workspaceId: "workspace",
        action: "acquire",
        role: "worker",
        agentId: "existing",
      });
      expect(acquired.ok).toBe(true);
      expect(ctx.scheduler.status().pending[0]?.agentId).toBeNull();
      if (state === "running") ctx.agents[0].status = "running";
      if (state === "active_turn") ctx.agents[0].activeTurn = { id: "new-turn" };
      const released = await ctx.scheduler.requestResource({
        requestId: "release",
        workspaceId: "workspace",
        action: "release",
        agentId: "existing",
        reservationId: acquired.reservationId,
      });
      expect(released.ok).toBe(state === "idle");
      expect(ctx.scheduler.status().pending).toHaveLength(state === "idle" ? 0 : 1);
      expect(ctx.store.tasks.get("workspace")?.phase).toBe(state === "idle" ? "queued" : "paused");
    },
  );
  it("retains a previously bound lease when its native member disappears", async () => {
    const ctx = setup();
    ctx.agents.push({
      id: "existing",
      workspaceId: "workspace",
      cwd: process.cwd(),
      provider: "codex",
      model: "cheap",
      status: "idle",
    });
    const acquired = await ctx.scheduler.requestResource({
      requestId: "acquire",
      workspaceId: "workspace",
      action: "acquire",
      role: "worker",
    });
    expect(
      (
        await ctx.scheduler.requestResource({
          requestId: "bind",
          workspaceId: "workspace",
          action: "bind",
          agentId: "existing",
          reservationId: acquired.reservationId,
        })
      ).ok,
    ).toBe(true);
    ctx.agents.length = 0;
    const released = await ctx.scheduler.requestResource({
      requestId: "release",
      workspaceId: "workspace",
      action: "release",
      agentId: "existing",
      reservationId: acquired.reservationId,
    });
    expect(released.ok).toBe(false);
    expect(ctx.scheduler.status().pending[0]).toMatchObject({ agentId: "existing", frozen: true });
  });
  it("admits the frozen actual override after its live preset is deleted", async () => {
    const ctx = setup();
    const override = ctx.store.presets.create({ name: "覆盖", provider: "codex", model: "first" });
    const frozen = TaskPresetSnapshotSchema.parse({
      presetId: override.id,
      source: "task",
      models: [
        { provider: "codex", model: "first", thinking: "", permissionMode: "auto" },
        { provider: "codex", model: "second", thinking: "medium", permissionMode: "accept-edits" },
      ],
      environmentKind: "project-default",
      runtimeEnv: "固定环境",
      instructions: "固定指令",
    });
    ctx.store.tasks.updateControl("workspace", {
      actualModels: [
        {
          agentId: "next",
          memberId: "next-member",
          role: "worker",
          confirmedAt: ctx.store.tasks.get("workspace")!.confirmedAt,
          presetId: override.id,
          presetSnapshot: frozen,
          admitted: false,
        },
      ],
    });
    ctx.store.presets.delete(override.id);
    const admitted = await ctx.scheduler.requestResource({
      requestId: "frozen",
      workspaceId: "workspace",
      action: "acquire",
      role: "worker",
      agentId: "next",
      presetId: override.id,
      provider: "codex",
      model: "second",
      candidateIndex: 1,
    });
    expect(admitted).toMatchObject({ ok: true, model: "second", presetId: override.id });
    expect(ctx.scheduler.status().pending[0]?.files).toEqual(["src/target.ts"]);
  });
  it("prebinds an exact registered identity before host creates the provider", async () => {
    const ctx = setup();
    const acquired = await ctx.scheduler.requestResource({
      requestId: "acquire",
      workspaceId: "workspace",
      action: "acquire",
      role: "worker",
    });
    ctx.runtime.registerSession({
      workspaceId: "workspace",
      agentId: "next",
      role: "worker",
      provider: "codex",
      model: "cheap",
      candidateIndex: 0,
    });
    const bound = await ctx.scheduler.requestResource({
      requestId: "bind",
      workspaceId: "workspace",
      action: "bind",
      reservationId: acquired.reservationId,
      agentId: "next",
    });
    expect(bound.ok).toBe(true);
    expect(ctx.scheduler.status().pending[0]?.agentId).toBe("next");
  });
  it("refuses unregistered or mismatched prospective identities", async () => {
    const ctx = setup();
    const acquired = await ctx.scheduler.requestResource({
      requestId: "acquire",
      workspaceId: "workspace",
      action: "acquire",
      role: "worker",
    });
    ctx.runtime.registerSession({
      workspaceId: "workspace",
      agentId: "next",
      role: "worker",
      provider: "codex",
      model: "other",
      candidateIndex: 0,
    });
    const bound = await ctx.scheduler.requestResource({
      requestId: "bind",
      workspaceId: "workspace",
      action: "bind",
      reservationId: acquired.reservationId,
      agentId: "next",
    });
    expect(bound.ok).toBe(false);
    expect(ctx.scheduler.status().pending[0]?.agentId).toBeNull();
  });
  it("releases a precreated identity after the owner confirms no native member was created", async () => {
    const ctx = setup();
    const acquired = await ctx.scheduler.requestResource({
      requestId: "acquire",
      workspaceId: "workspace",
      action: "acquire",
      role: "worker",
    });
    ctx.runtime.registerSession({
      workspaceId: "workspace",
      agentId: "next",
      role: "worker",
      provider: "codex",
      model: "cheap",
      candidateIndex: 0,
    });
    await ctx.scheduler.requestResource({
      requestId: "bind",
      workspaceId: "workspace",
      action: "bind",
      reservationId: acquired.reservationId,
      agentId: "next",
    });
    const released = await ctx.scheduler.requestResource({
      requestId: "release",
      workspaceId: "workspace",
      action: "release",
      reservationId: acquired.reservationId,
      agentId: "next",
    });
    expect(released.ok).toBe(true);
    expect(ctx.scheduler.status().pending).toEqual([]);
  });
  it("accepts an explicit model handover while retaining confirmed file scope", async () => {
    const ctx = setup();
    const override = ctx.store.presets.create({ name: "接手", provider: "codex", model: "second" });
    const acquired = await ctx.scheduler.requestResource({
      requestId: "acquire",
      workspaceId: "workspace",
      action: "acquire",
      role: "worker",
      presetId: override.id,
      candidateIndex: 0,
    });
    expect(acquired).toMatchObject({ ok: true, model: "second", presetId: override.id });
    expect(ctx.scheduler.status().pending[0]?.files).toEqual(["src/target.ts"]);
    expect(ctx.store.tasks.get("workspace")?.rolesSnapshot?.worker.models[0].model).toBe("cheap");
  });
  it("admits only the exact existing member for compact after verification", async () => {
    const ctx = setup();
    ctx.store.tasks.setPhase("workspace", "executing");
    ctx.store.tasks.setPhase("workspace", "verifying");
    ctx.store.tasks.setPhase("workspace", "awaiting_acceptance");
    ctx.runtime.registerSession({
      workspaceId: "workspace",
      agentId: "existing",
      role: "worker",
      provider: "codex",
      model: "cheap",
      candidateIndex: 0,
    });
    const acquired = await ctx.scheduler.requestResource({
      requestId: "compact",
      workspaceId: "workspace",
      action: "acquire",
      operation: "compact",
      role: "worker",
      agentId: "existing",
      provider: "codex",
      model: "cheap",
    });
    expect(acquired.ok).toBe(true);
    expect(ctx.scheduler.status().pending[0]?.access).toBe("read");
  });
});
