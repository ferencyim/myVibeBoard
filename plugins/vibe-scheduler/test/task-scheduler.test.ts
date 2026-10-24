import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeviceLeases,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  publishEvent,
} from "../server/vibe/db";
import { resolveTaskRoles, type TaskPlan, type TaskRoleSnapshot } from "../server/vibe/contract";
import { createPortAllocator } from "../server/ports";
import {
  createTaskScheduler,
  normalizeTaskFiles,
  type NativeTaskWorkspace,
  type TaskResourceRequest,
} from "../server/task-scheduler";
import { DEFAULT_CONFIG } from "../server/scheduler";
import { createSchedulerRuntime, DEFAULT_SETTINGS } from "../server/runtime";
import { fakeMachine } from "./helpers";

function confirmTask(store: ReturnType<typeof createVibeStore>, id: string, roles: TaskRoleSnapshot) {
  const task = store.tasks.get(id)!;
  const tab =
    task.tabs.find((item) => item.agentId === task.anchorAgentId) ??
    store.tasks.allocateTab(id, {
      agentId: task.anchorAgentId,
      role: "main",
      provider: "codex",
      model: "first",
    }).tab;
  return store.tasks.confirm(id, {
    rolesSnapshot: roles,
    planSource: { tabNumber: tab.number, agentId: tab.agentId, sourceKey: "test-" + id },
  });
}
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup(limit = 2) {
  const db = openVibeDb({ path: ":memory:" });
  closers.push(() => db.close());
  migrateOwner(db, "scheduler");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date(time);
  const store = createVibeStore(db, { now });
  store.masterDispatch.publish({
    enabled: false,
    available: false,
    reason: "",
    timeoutSeconds: 10,
  });
  const dir = mkdtempSync(join(tmpdir(), "vibe-task-scheduler-"));
  const project = store.projects.create({
    name: "测试",
    prefix: "TASK",
    repoPath: dir,
    paseoProjectId: "native-project",
  });
  const preset = store.presets.create({ name: "测试模型", provider: "codex", model: "model" });
  const roles = resolveTaskRoles(
    {},
    null,
    { planner: preset.id, worker: preset.id, verifier: preset.id },
    (id) => store.presets.get(id),
  );
  const leases = createDeviceLeases(db, { now });
  const ports = createPortAllocator({ base: 17500, span: 50, isFree: async () => true });
  const native = new Map<string, NativeTaskWorkspace>();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let config = { ...DEFAULT_CONFIG, globalLimit: limit };
  let memory = 0.2;
  const file = join(dir, "resources.json");
  const makeScheduler = () =>
    createTaskScheduler({
      store,
      leases,
      ports,
      now,
      file,
      config: () => config,
      memory: () => memory,
      quota: () => ({}),
      native: async (id) => native.get(id) ?? null,
      identity: async (directory) => ({
        repo: "same-real-repository",
        directory: directory.toLowerCase(),
      }),
      emit: (type, payload) => {
        events.push({ type, payload });
      },
    });
  const scheduler = makeScheduler();
  const plan = (files: string[]): TaskPlan => ({
    goal: "目标",
    approach: "做法",
    files,
    subtasks: [
      {
        id: "one",
        goal: "一",
        method: "实现",
        notes: "",
        dependsOn: [],
        files: ["src/a.ts"],
        acceptance: "测试",
      },
      {
        id: "two",
        goal: "二",
        method: "实现",
        notes: "",
        dependsOn: [],
        files: ["src/b.ts"],
        acceptance: "测试",
      },
    ],
    checks: [{ text: "测试", method: "单测" }],
  });
  function task(id: string, files = ["src/a.ts"], confirmed = true) {
    native.set(id, {
      workspaceId: id,
      projectId: "native-project",
      directory: dir,
      archived: false,
      agents: [],
    });
    store.tasks.create({ workspaceId: id, anchorAgentId: "anchor-" + id });
    store.tasks.savePlan(id, plan(files));
    if (confirmed) {
      time += 1000;
      confirmTask(store, id, roles);
    }
    return store.tasks.get(id)!;
  }
  const request = (
    workspaceId: string,
    rest: Omit<TaskResourceRequest, "requestId" | "workspaceId">,
  ) => scheduler.requestResource({ requestId: String(++time), workspaceId, ...rest });
  async function bind(
    workspaceId: string,
    reservationId: string,
    id = "agent-" + workspaceId,
    provider = "codex",
    model = "model",
  ) {
    native.get(workspaceId)!.agents.push({
      id,
      workspaceId,
      cwd: dir,
      provider,
      model,
      status: "idle",
      activeTurn: null,
    });
    return request(workspaceId, { action: "bind", reservationId, agentId: id });
  }
  return {
    db,
    dir,
    store,
    project,
    preset,
    roles,
    leases,
    ports,
    native,
    scheduler,
    makeScheduler,
    task,
    plan,
    request,
    bind,
    events,
    setConfig: (value: Partial<typeof config>) => {
      config = { ...config, ...value };
    },
    setMemory: (value: number) => {
      memory = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
    file,
  };
}

describe("原生任务准入", () => {
  it("只准入已确认任务，按确认时间 FIFO", async () => {
    const t = setup(1);
    t.task("unconfirmed", ["x"], false);
    t.task("first");
    t.task("second", ["src/b.ts"]);
    const output = await t.scheduler.tick();
    expect(output.admitted.map((row) => row.workspaceId)).toEqual(["first"]);
    expect(output.deferred.second).toMatch(/全局/);
    expect(t.events.map((row) => row.type)).toEqual(["scheduler.task_admitted"]);
    expect(await t.request("unconfirmed", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
    });
  });
  it("全局、provider、原生项目并发同时约束主、子和辅助角色", async () => {
    const t = setup(4);
    t.task("a");
    t.task("b", ["src/b.ts"]);
    t.setConfig({ providerLimits: { codex: 1 } });
    const main = await t.request("a", { action: "acquire", role: "worker" });
    expect(main.ok).toBe(true);
    expect(await t.request("b", { action: "acquire", role: "reviewer" })).toMatchObject({
      ok: false,
    });
    expect(await t.request("b", { action: "acquire", role: "verifier" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/并发/),
    });
    t.setConfig({ providerLimits: {} });
    t.store.projectConfigs.update("native-project", { concurrencyLimit: 1 });
    expect(await t.request("b", { action: "acquire", role: "verifier" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/项目/),
    });
  });
  it("并发 1 时主代理空闲后让出，子代理完成后主代理重新准入", async () => {
    const t = setup(1);
    t.task("a");
    const main = await t.request("a", { action: "acquire", role: "worker" });
    await t.bind("a", main.reservationId!, "main");
    t.store.tasks.setPhase("a", "executing");
    expect(
      await t.request("a", { action: "yield", reservationId: main.reservationId }),
    ).toMatchObject({ ok: true });
    const sub = await t.request("a", { action: "acquire", role: "subagent", subtaskId: "one" });
    expect(sub.ok).toBe(true);
    await t.bind("a", sub.reservationId!, "sub");
    expect(await t.request("a", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/全局/),
    });
    expect(
      await t.request("a", { action: "release", reservationId: sub.reservationId }),
    ).toMatchObject({ ok: true });
    expect(await t.request("a", { action: "acquire", role: "worker" })).toMatchObject({
      ok: true,
      reservationId: main.reservationId,
    });
    expect(t.scheduler.runningCounts().total).toBe(1);
  });
  it("同worktree主子代理与不同projectId仓库别名都检查真实仓库文件范围", async () => {
    const t = setup(8);
    t.task("a");
    t.task("b", ["SRC\\A.ts"]);
    t.task("unknown", []);
    t.task("safe", ["docs/a.md"]);
    expect((await t.request("a", { action: "acquire", role: "worker" })).ok).toBe(true);
    expect(
      await t.request("a", { action: "acquire", role: "subagent", subtaskId: "one" }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/文件范围/) });
    expect(
      (await t.request("a", { action: "acquire", role: "subagent", subtaskId: "two" })).ok,
    ).toBe(true);
    t.native.get("b")!.projectId = "another-project";
    expect(await t.request("b", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/文件范围/),
    });
    expect(await t.request("unknown", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/文件范围/),
    });
    expect((await t.request("safe", { action: "acquire", role: "worker" })).ok).toBe(true);
  });
  it("验证屏障拒绝活跃写者并阻止后续写者", async () => {
    const t = setup(4);
    t.task("a");
    t.task("b", ["different.ts"]);
    const worker = await t.request("a", { action: "acquire", role: "worker" });
    await t.bind("a", worker.reservationId!);
    expect(await t.request("a", { action: "acquire", role: "verifier" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/文件范围/),
    });
    await t.request("a", { action: "release", reservationId: worker.reservationId });
    const verifier = await t.request("a", { action: "acquire", role: "verifier" });
    expect(verifier.ok).toBe(true);
    expect(await t.request("b", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/文件范围/),
    });
  });
  it("正在运行的会话不能yield或release，超时也保留计算、锁、设备和端口", async () => {
    const t = setup();
    t.task("a");
    t.store.tasks.setPhase("a", "executing");
    t.roles.worker.runtimeEnv = "android";
    // A task's frozen roles must be set before confirmation.
    t.task("device", ["device.ts"], false);
    confirmTask(t.store, "device", t.roles);
    t.leases.registerDevice({ kind: "emulator", name: "测试设备" });
    const main = await t.request("device", { action: "acquire", role: "worker" });
    await t.bind("device", main.reservationId!);
    t.native.get("device")!.agents[0]!.status = "running";
    t.native.get("device")!.agents[0]!.activeTurn = { id: "turn" };
    expect(
      await t.request("device", { action: "release", reservationId: main.reservationId }),
    ).toMatchObject({ ok: false });
    t.advance(10 * 24 * 60 * 60 * 1000);
    expect(t.scheduler.runningCounts().total).toBe(1);
    expect(t.leases.activeLeases()).toHaveLength(1);
    expect(t.ports.get(main.reservationId!)).toBe(main.port);
    t.native.get("device")!.agents[0]!.status = "idle";
    t.native.get("device")!.agents[0]!.activeTurn = null;
    expect(await t.request("device", { action: "reconcile" })).toMatchObject({ ok: true });
    expect(t.scheduler.runningCounts().total).toBe(0);
    expect(t.leases.activeLeases()).toHaveLength(0);
  });
  it("同任务设备可在主代理yield后顺序借用，活跃子代理阻止主代理resume", async () => {
    const t = setup(3);
    t.roles.worker.runtimeEnv = "android";
    t.roles.subagent.runtimeEnv = "android";
    t.task("a", [], false);
    confirmTask(t.store, "a", t.roles);
    t.leases.registerDevice({ kind: "emulator", name: "设备" });
    const main = await t.request("a", { action: "acquire", role: "worker" });
    await t.bind("a", main.reservationId!, "main");
    await t.request("a", { action: "yield", reservationId: main.reservationId });
    const sub = await t.request("a", { action: "acquire", role: "subagent", subtaskId: "two" });
    await t.bind("a", sub.reservationId!, "sub");
    expect(sub.deviceIds).toEqual(main.deviceIds);
    expect(t.leases.activeLeases()).toHaveLength(1);
    expect(await t.request("a", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
    });
    await t.request("a", { action: "release", reservationId: main.reservationId });
    expect(t.leases.activeLeases()).toHaveLength(1);
    await t.request("a", { action: "release", reservationId: sub.reservationId });
    expect(t.leases.activeLeases()).toHaveLength(0);
  });
  it("已绑定agent的模型/目录必须与准入一致，重复acquire不能复用为新写者", async () => {
    const t = setup();
    t.task("a");
    const main = await t.request("a", { action: "acquire", role: "worker" });
    expect(await t.bind("a", main.reservationId!, "bad", "codex", "wrong-model")).toMatchObject({
      ok: false,
    });
    t.native.get("a")!.agents[0]!.model = "model";
    t.native.get("a")!.agents[0]!.archivedAt = "2026-01-01T00:00:00Z";
    expect(
      await t.request("a", { action: "bind", reservationId: main.reservationId, agentId: "bad" }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/归档/) });
    expect(await t.request("a", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/已有准入/),
    });
  });
  it("重启后先核对，不重发已准入请求；未停止agent仍占名额", async () => {
    const t = setup(1);
    t.task("a");
    const main = await t.request("a", { action: "acquire", role: "worker" });
    await t.bind("a", main.reservationId!);
    t.native.get("a")!.agents[0]!.status = "running";
    const restarted = t.makeScheduler();
    expect((await restarted.tick()).admitted).toEqual([]);
    expect(restarted.runningCounts().total).toBe(1);
    expect(t.store.tasks.get("a")!.phase).toBe("paused");
    t.native.get("a")!.agents[0]!.status = "idle";
    expect(
      await restarted.requestResource({
        requestId: "restart",
        workspaceId: "a",
        action: "reconcile",
      }),
    ).toMatchObject({ ok: true });
    expect(restarted.runningCounts().total).toBe(0);
    expect((await restarted.tick()).admitted).toEqual([]);
  });
  it("损坏租约文件和原生状态不可读时都停止新派发", async () => {
    const t = setup();
    t.task("a");
    writeFileSync(t.file, "bad json");
    const restarted = t.makeScheduler();
    expect((await restarted.tick()).admitted).toEqual([]);
    t.native.delete("a");
    await expect(t.makeScheduler().tick()).rejects.toThrow(/核对/);
  });
  it("总agent只排序已确认候选，关闭/不可用/超时退回FIFO", async () => {
    const t = setup(2);
    t.task("unconfirmed", ["u"], false);
    t.task("first", ["a.ts"]);
    t.task("second", ["b.ts"]);
    t.store.masterDispatch.publish({
      enabled: true,
      available: true,
      reason: "",
      timeoutSeconds: 10,
    });
    expect((await t.scheduler.tick()).admitted).toEqual([]);
    const wanted = t.events.at(-1)!.payload;
    expect(wanted.workspaceIds).toEqual(["first", "second"]);
    t.scheduler.handleMasterChosen({
      requestId: String(wanted.requestId),
      workspaceIds: ["unconfirmed", "second", "first"],
      reason: "先二",
    });
    expect((await t.scheduler.tick()).admitted.map((row) => row.workspaceId)).toEqual([
      "second",
      "first",
    ]);
    const other = setup(1);
    other.task("fifo");
    other.store.masterDispatch.publish({
      enabled: true,
      available: true,
      reason: "",
      timeoutSeconds: 10,
    });
    await other.scheduler.tick();
    other.advance(300_000);
    expect((await other.scheduler.tick()).admitted.map((row) => row.workspaceId)).toEqual(["fifo"]);
  });
  it("维护只读planner和总agent也占计算名额，不授予worker执行", async () => {
    const t = setup(1);
    t.task("plan", [], false);
    const planner = await t.request("plan", {
      action: "acquire",
      role: "planner",
      provider: "codex",
      model: "model",
    });
    expect(planner.ok).toBe(true);
    expect(await t.request("plan", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
    });
    t.native.set("master", {
      workspaceId: "master",
      projectId: "master-project",
      directory: t.dir,
      archived: false,
      agents: [],
    });
    expect(
      await t.request("master", {
        action: "acquire",
        role: "master",
        provider: "codex",
        model: "model",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/全局/) });
  });
  it("直接在yield tab新增原生回合将冻结并计回名额，不能绕过冲突锁", async () => {
    const t = setup(1);
    t.task("a");
    const main = await t.request("a", { action: "acquire", role: "worker" });
    await t.bind("a", main.reservationId!, "main");
    await t.request("a", { action: "yield", reservationId: main.reservationId });
    t.native.get("a")!.agents[0]!.status = "running";
    expect(await t.scheduler.observeAgent("a", "main")).toBe(false);
    expect(t.scheduler.runningCounts().total).toBe(1);
    expect(t.store.tasks.get("a")!.phase).toBe("paused");
  });
  it("文件范围规范化不会让..、未知范围或复杂glob绕过互斥", async () => {
    const t = setup();
    mkdirSync(join(t.dir, "src"));
    expect(await normalizeTaskFiles(["./src/../x.ts"], t.dir)).toEqual(["**"]);
    expect(await normalizeTaskFiles([], t.dir)).toEqual(["**"]);
    expect(await normalizeTaskFiles(["src/{a,b}.ts"], t.dir)).toEqual(["**"]);
    expect(await normalizeTaskFiles(["./src/a.ts"], t.dir)).toEqual(["src/a.ts"]);
  });
  it("生产 runtime 消费资源事件并发布拒绝响应", async () => {
    const t = setup();
    t.task("a");
    const runtime = createSchedulerRuntime({
      db: t.db,
      dataDir: join(t.dir, "runtime"),
      probe: fakeMachine(),
      settings: DEFAULT_SETTINGS,
      native: async (id) => t.native.get(id) ?? null,
      isPortFree: async () => true,
    });
    // Identity resolution intentionally uses a real Git worktree in production; a plain temp path is denied.
    publishEvent(t.db, {
      type: "scheduler.task_resource_request",
      payload: { requestId: "bus", workspaceId: "a", action: "acquire", role: "worker" },
    });
    await runtime.tickOnce();
    const response = t.db
      .prepare<{ payload_json: string }>(
        "SELECT payload_json FROM vibe_event WHERE type='scheduler.task_resource_result'",
      )
      .get();
    expect(JSON.parse(response!.payload_json)).toMatchObject({ requestId: "bus", ok: false });
    await runtime.stop();
  });
  it("同workspace不同设备kind各持正确设备，不借错设备", async () => {
    const t = setup(3);
    t.roles.worker.runtimeEnv = "android";
    t.roles.subagent.runtimeEnv = "ios-simulator";
    t.task("a", [], false);
    confirmTask(t.store, "a", t.roles);
    const emulator = t.leases.registerDevice({ kind: "emulator", name: "安卓" });
    const simulator = t.leases.registerDevice({ kind: "simulator", name: "模拟器" });
    const main = await t.request("a", { action: "acquire", role: "worker" });
    await t.bind("a", main.reservationId!, "main");
    await t.request("a", { action: "yield", reservationId: main.reservationId });
    const sub = await t.request("a", { action: "acquire", role: "subagent", subtaskId: "one" });
    expect(main.deviceIds).toEqual([emulator.id]);
    expect(sub.deviceIds).toEqual([simulator.id]);
    expect(t.leases.activeLeases()).toHaveLength(2);
  });
  it("master插件host文件写锁明确授权、互斥且只在完成后释放", async () => {
    const t = setup(3);
    t.task("a", [".vibe/MEMORY.md"]);
    t.task("b", [".vibe/**"]);
    const operation = {
      action: "acquire" as const,
      role: "master" as const,
      provider: "codex",
      model: "model",
      files: [".vibe/**"],
    };
    expect(await t.request("a", operation)).toMatchObject({ ok: false });
    const host = await t.request("a", { ...operation, hostLease: true });
    expect(host.ok).toBe(true);
    expect(await t.request("b", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(
      await t.request("a", { action: "release", reservationId: host.reservationId }),
    ).toMatchObject({ ok: true });
    expect((await t.request("b", { action: "acquire", role: "worker" })).ok).toBe(true);
  });
  it("忙碌资源明确可重试，无效确认不可重试，端口范围在线变更影响新分配", async () => {
    const t = setup(1);
    t.task("a");
    t.task("b", ["different.ts"]);
    t.task("plan", [], false);
    const main = await t.request("a", { action: "acquire", role: "worker" });
    expect(await t.request("b", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(await t.request("plan", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      retryable: false,
    });
    t.ports.configure({ base: 17600, span: 10 });
    expect(await t.ports.allocate("later")).toBe(17600);
    expect(t.ports.get(main.reservationId!)).toBe(main.port);
  });
  it("损坏端口文件不能重新分配旧端口；原生状态未知不能声称reconcile成功", async () => {
    const t = setup();
    const file = join(t.dir, "bad-ports.json");
    writeFileSync(file, "bad json");
    const ports = createPortAllocator({ file, base: 17600, span: 2, isFree: async () => true });
    await expect(ports.allocate("new")).rejects.toThrow(/不可读/);
    t.task("a");
    const row = await t.request("a", { action: "acquire", role: "worker" });
    expect(row.ok).toBe(true);
    t.native.delete("a");
    expect(await t.request("a", { action: "reconcile" })).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(t.scheduler.runningCounts().total).toBe(1);
  });
  it("子任务自定义预设只读本轮冻结快照，缺失时拒绝而不回落到默认", async () => {
    const t = setup(3);
    const custom = t.store.presets.create({
      name: "子任务预设",
      provider: "claude",
      model: "frozen-model",
    });
    t.task("custom", ["src/a.ts"], false);
    const plan = t.plan(["src/a.ts"]);
    plan.subtasks[0]!.presetId = custom.id;
    t.store.tasks.savePlan("custom", plan);
    const selected = resolveTaskRoles(
      { subagent: { mode: "preset", presetId: custom.id } },
      null,
      { planner: t.preset.id, worker: t.preset.id, verifier: t.preset.id },
      (id) => t.store.presets.get(id),
    );
    const roles = { ...t.roles, subtaskPresets: { one: selected.subagent } };
    confirmTask(t.store, "custom", roles);
    t.store.presets.update(custom.id, {
      models: [{ provider: "codex", model: "changed-model", thinking: "", permissionMode: "auto" }],
    });
    const output = await t.request("custom", {
      action: "acquire",
      role: "subagent",
      subtaskId: "one",
    });
    expect(output).toMatchObject({
      ok: true,
      presetId: custom.id,
      provider: "claude",
      model: "frozen-model",
    });
    await t.request("custom", { action: "reconcile" });
    // Corrupt persisted fixture represents a pre-extension confirmation; production writes use commands.
    t.db
      .prepare("UPDATE task SET roles_snapshot_json = ? WHERE workspace_id = ?")
      .run(JSON.stringify(t.roles), "custom");
    expect(
      await t.request("custom", { action: "acquire", role: "subagent", subtaskId: "one" }),
    ).toMatchObject({ ok: false, retryable: false, reason: expect.stringMatching(/快照|预设/) });
    expect(await t.request("custom", { action: "acquire", role: "worker" })).toMatchObject({
      ok: false,
      retryable: false,
      reason: expect.stringMatching(/快照|预设/),
    });
  });
});
