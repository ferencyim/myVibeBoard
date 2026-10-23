import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginTaskConversationPrepareRequest } from "@getpaseo/plugin/server";
import { openBoardRuntime } from "../server/service";
import { createTaskHost, recipientFromPreset } from "../server/task-host";
import { createTaskResources } from "../server/task-host/resources";
import { createTaskRuntimeCommands, publishEvent } from "../server/vibe/db";

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});
function setup(defaults = true) {
  const runtime = openBoardRuntime({ path: ":memory:" });
  closers.push(() => runtime.close());
  const store = runtime.store;
  const preset = store.presets.create({
    name: "测试",
    provider: "codex",
    model: "cheap",
    permissionMode: "full",
  });
  if (defaults)
    store.modelDefaults.setGlobal({ planner: preset.id, worker: preset.id, verifier: preset.id });
  const members: Array<{
    memberId: string;
    backendAgentId: string;
    role: string;
    config?: PluginTaskConversationPrepareRequest["recipient"]["config"];
  }> = [];
  const canonical = {
    members,
    anchorAgentId: null as string | null,
    workspaceId: "workspace",
    ownerPluginId: "vibe-board",
  };
  const sourceState = {
    error: null as string | null,
    row: null as null | {
      kind: string;
      completed: boolean;
      speaker: { role: string };
      source: { memberId: string; backendAgentId: string };
    },
  };
  const workspace = {
    workspaceKind: "worktree",
    projectKind: "git",
    workspaceDirectory: process.cwd(),
    projectRootPath: process.cwd() + "/main",
  };
  const paseo = {
    workspaces: {
      ref: () => ({
        directory: process.cwd(),
        projectId: "project",
        refresh: async () => workspace,
      }),
    },
    taskConversations: {
      ref: () => ({ refresh: async () => canonical, querySource: async () => sourceState }),
    },
  } as unknown as PaseoApi;
  const host = createTaskHost({ ...runtime, paseo: () => paseo, resourceTimeoutMs: 100 });
  host.registerPrompts();
  const context = { paseo, signal: new AbortController().signal };
  const request: PluginTaskConversationPrepareRequest = {
    conversationId: "conversation",
    workspaceId: "workspace",
    ownerPluginId: "vibe-board",
    anchorAgentId: null,
    memberId: "planner-member",
    backendAgentId: "planner-agent",
    clientMessageId: "first",
    text: "请实现目标",
    throughSeq: 0,
    publicContext: [],
    ready: false,
    recipient: {
      role: "planner",
      presetId: preset.id,
      config: {
        provider: "codex",
        model: "cheap",
        cwd: process.cwd(),
        modeId: "full-access",
        providerOptions: { sandbox_mode: "danger-full-access" },
      },
    },
  };
  return { ...runtime, host, preset, context, request, members, canonical, sourceState, workspace };
}
async function confirmHost(ctx: ReturnType<typeof setup>) {
  await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
  const task = ctx.store.tasks.confirm("workspace", {
    plan: {
      goal: "目标",
      approach: "做法",
      files: ["src/a.ts"],
      subtasks: [],
      checks: [{ text: "检查", method: "测试" }],
    },
    rolesSnapshot: await ctx.host.resolveRoles(ctx.store.tasks.get("workspace")!),
    planSource: {
      conversationId: "conversation",
      sourceKey: "plan",
      memberId: "planner-member",
      backendAgentId: "planner-agent",
    },
  });
  ctx.store.tasks.setPhase("workspace", "executing");
  return task;
}
function admitPreparedChoices(ctx: ReturnType<typeof setup>) {
  const choices = ctx.store.tasks.get("workspace")!.control!.actualModels as Array<
    Record<string, unknown>
  >;
  for (const choice of choices) choice.admitted = true;
  ctx.store.tasks.updateControl("workspace", { actualModels: choices });
}
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("task conversation host", () => {
  it.each(["checkout", "local_checkout", "directory"])(
    "rejects %s workspaces before binding a task or freezing its model",
    async (kind) => {
      const ctx = setup();
      ctx.workspace.workspaceKind = kind;
      expect(await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context)).toMatchObject({
        ready: false,
        reason: expect.stringContaining("附加 Git worktree"),
      });
      expect(ctx.store.tasks.list()).toEqual([]);
    },
  );
  it("rejects a main checkout even when its native kind says worktree", async () => {
    const ctx = setup();
    ctx.workspace.projectRootPath = ctx.workspace.workspaceDirectory + "/.";
    expect(await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context)).toMatchObject({
      ready: false,
      reason: expect.stringContaining("项目主检出"),
    });
    expect(ctx.store.tasks.list()).toEqual([]);
  });
  it("polls resource responses only after the durable request sequence using a rowid range", async () => {
    const ctx = setup();
    const resources = createTaskResources(ctx.db, 1000);
    for (let index = 0; index < 30; index++)
      publishEvent(ctx.db, {
        type: "scheduler.task_resource_result",
        payload: {
          requestId: "historical-" + index,
          workspaceId: "workspace",
          action: "freeze",
          ok: true,
          reason: "历史响应",
        },
      });
    const statements = vi.spyOn(ctx.db, "prepare");
    const pending = resources.request({ workspaceId: "workspace", action: "freeze" });
    const request = ctx.db
      .prepare<{ seq: number; payload_json: string }>(
        "SELECT seq, payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request' ORDER BY seq DESC LIMIT 1",
      )
      .get()!;
    expect(request.seq).toBeGreaterThan(30);
    publishEvent(ctx.db, {
      type: "scheduler.task_resource_result",
      payload: { ...JSON.parse(request.payload_json), ok: true, reason: "当前响应" },
    });
    await expect(pending).resolves.toMatchObject({ ok: true, reason: "当前响应" });
    const query = statements.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.startsWith("SELECT payload_json") && sql.includes("json_extract"))!;
    expect(query).toContain("seq > ?");
    const plan = ctx.db
      .prepare<{ detail: string }>("EXPLAIN QUERY PLAN " + query)
      .all(request.seq, JSON.parse(request.payload_json).requestId);
    expect(plan.map((row) => row.detail).join(" ")).toContain("rowid>?");
    statements.mockRestore();
  });
  it.each(["reviewer", "verifier"] as const)(
    "%s preparation excludes old confirmations and verification verdicts from current context",
    async (role) => {
      const ctx = setup();
      ctx.store.modelDefaults.setGlobal({
        planner: ctx.preset.id,
        worker: ctx.preset.id,
        verifier: ctx.preset.id,
        reviewer: ctx.preset.id,
      });
      const task = await confirmHost(ctx);
      for (const [sourceKey, kind, confirmedAt] of [
        ["old-confirmation", "delivery", null],
        ["early-delivery", "delivery", task.confirmedAt],
        ["latest-delivery", "delivery", task.confirmedAt],
        ["wrong-commit-delivery", "delivery", task.confirmedAt],
        ["unbound-delivery", "delivery", task.confirmedAt],
        ["old-interrupted-verdict", "verification", task.confirmedAt],
      ] as const) {
        ctx.store.taskArtifacts.record({
          workspaceId: "workspace",
          kind,
          sourceKey,
          confirmedAt,
          source: {
            conversationId: "conversation",
            memberId: ["wrong-commit-delivery", "unbound-delivery"].includes(sourceKey)
              ? sourceKey
              : "worker",
            backendAgentId: "worker-agent",
            sourceKey,
          },
          summary: sourceKey,
          data:
            sourceKey === "unbound-delivery"
              ? null
              : {
                  commitHash: sourceKey === "latest-delivery" ? "current-commit" : "old-commit",
                  conclusion: "doubt",
                  voided: true,
                },
        });
      }
      ctx.store.tasks.setPhase("workspace", role === "reviewer" ? "reviewing" : "verifying");
      const request = {
        ...ctx.request,
        memberId: role + "-member",
        backendAgentId: role + "-agent",
        recipient: {
          ...ctx.request.recipient,
          role,
          env: { VIBE_VERIFICATION_COMMIT: "current-commit" },
        },
      };
      const prepared = await ctx.host.hooks.prepare({ request }, ctx.context);
      expect(prepared?.ready).toBe(true);
      expect(prepared?.context).toContain("latest-delivery");
      expect(prepared?.context).toContain("unbound-delivery");
      expect(prepared?.context).toContain("未绑定提交的声称不能证明当前提交");
      for (const old of [
        "old-confirmation",
        "early-delivery",
        "old-interrupted-verdict",
        "wrong-commit-delivery",
      ])
        expect(prepared?.context).not.toContain(old);
      expect(ctx.store.taskArtifacts.list("workspace")).toHaveLength(6);
    },
  );
  it.each([
    { outcome: "completed", role: "planner" },
    { outcome: "failed", role: "planner" },
    { outcome: "missing_member", role: "planner" },
    { outcome: "wrong_config", role: "planner" },
    { outcome: "completed", role: "reviewer" },
    { outcome: "completed", role: "verifier" },
  ] as const)(
    "recovers only a canonically reused completed leaf session: $role/$outcome",
    async ({ outcome, role }) => {
      const ctx = setup();
      if (role !== "planner") {
        ctx.store.modelDefaults.setGlobal({
          planner: ctx.preset.id,
          worker: ctx.preset.id,
          verifier: ctx.preset.id,
          reviewer: ctx.preset.id,
        });
        await confirmHost(ctx);
        ctx.store.tasks.setPhase("workspace", role === "reviewer" ? "reviewing" : "verifying");
      }
      const request = {
        ...ctx.request,
        backendAgentId: role + "-agent",
        memberId: role + "-member",
        recipient: {
          ...ctx.request.recipient,
          role,
          config: {
            ...ctx.request.recipient.config,
            modeId: "read-only",
          },
        },
      };
      const prepared = await ctx.host.hooks.prepare({ request }, ctx.context);
      const runtime = createTaskRuntimeCommands(ctx.db);
      const session = runtime.registerSession({
        workspaceId: "workspace",
        agentId: request.backendAgentId,
        role,
        provider: "codex",
        model: "cheap",
        candidateIndex: 0,
        confirmedAt: "2026-10-22T00:00:00.000Z",
      });
      ctx.store.sessions.setState(session.id, "ended", {
        outcome: outcome === "failed" ? "failed" : "completed",
      });
      if (outcome !== "missing_member")
        ctx.members.push({
          memberId: request.memberId,
          backendAgentId: request.backendAgentId,
          role,
          config: {
            ...prepared!.config!,
            model: outcome === "wrong_config" ? "different" : "cheap",
          },
        });
      const retry = await ctx.host.hooks.prepare({ request }, ctx.context);
      expect(retry?.ready).toBe(true);
      expect(runtime.getSession(session.id)?.state).toBe("ended");
      const states: Array<{ action: string; state: string }> = [];
      const handledActions = new Set<string>();
      const timer = setInterval(() => {
        for (const row of ctx.db
          .prepare<{ payload_json: string }>(
            "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
          )
          .all()) {
          const input = JSON.parse(row.payload_json);
          if (handledActions.has(input.action)) continue;
          handledActions.add(input.action);
          states.push({ action: input.action, state: runtime.getSession(session.id)!.state });
          publishEvent(ctx.db, {
            type: "scheduler.task_resource_result",
            payload: {
              ...input,
              reservationId: "reused",
              provider: "codex",
              model: "cheap",
              ok: true,
              reason: "已准入",
            },
          });
        }
      }, 1);
      try {
        const admitted = await ctx.host.hooks.admit(
          {
            request: {
              ...request,
              operation: "send",
              admitted: false,
            },
          },
          ctx.context,
        );
        expect(states[0]).toEqual({ action: "acquire", state: "ended" });
        if (outcome === "completed") {
          expect(admitted?.admitted).toBe(true);
          expect(states[1]).toEqual({ action: "bind", state: "idle" });
          expect(runtime.getSession(session.id)).toMatchObject({
            state: "idle",
            confirmedAt: ctx.store.tasks.get("workspace")!.confirmedAt,
            endedAt: null,
          });
          expect(ctx.store.sessions.setState(session.id, "working").state).toBe("working");
        } else {
          expect(admitted?.admitted).toBe(false);
          expect(states).toEqual([
            { action: "acquire", state: "ended" },
            { action: "release", state: "ended" },
          ]);
          expect(runtime.getSession(session.id)).toMatchObject({
            state: "ended",
            confirmedAt: "2026-10-22T00:00:00.000Z",
          });
        }
      } finally {
        clearInterval(timer);
      }
    },
  );
  it.each(["inherit", "preset", "global", "project"] as const)(
    "uses current %s planning defaults while preserving exact member continuation",
    async (change) => {
      const ctx = setup();
      await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
      admitPreparedChoices(ctx);
      const next = ctx.store.presets.create({ name: "新默认", provider: "codex", model: "next" });
      if (change === "inherit" || change === "global")
        ctx.store.modelDefaults.setGlobal({
          planner: next.id,
          worker: ctx.preset.id,
          verifier: ctx.preset.id,
        });
      if (change === "inherit")
        ctx.store.tasks.setRoleSelections("workspace", { planner: { mode: "inherit" } });
      if (change === "preset")
        ctx.store.tasks.setRoleSelections("workspace", {
          planner: { mode: "preset", presetId: next.id },
        });
      if (change === "project")
        ctx.store.projects.create({
          name: "项目",
          prefix: "DEF",
          repoPath: process.cwd(),
          paseoProjectId: "project",
          defaultPresets: { planner: next.id },
        });
      const task = ctx.store.tasks.get("workspace")!;
      expect((await ctx.host.resolveRecipient(task, "planner")).config.model).toBe("next");
      expect(
        (await ctx.host.resolveRecipient(task, "planner", { memberId: "planner-member" })).config
          .model,
      ).toBe("cheap");
      const source = createTaskRuntimeCommands(ctx.db).registerSession({
        workspaceId: "workspace",
        agentId: "planner-agent",
        role: "planner",
        provider: "codex",
        model: "cheap",
        candidateIndex: 0,
        confirmedAt: null,
      });
      expect(
        (await ctx.host.resolveRecipient(task, "planner", { fromSessionId: source.id })).config
          .model,
      ).toBe("cheap");
    },
  );
  it("honors disabled optional planning roles without deleting their exact member snapshot", async () => {
    const ctx = setup();
    ctx.store.modelDefaults.setGlobal({
      planner: ctx.preset.id,
      worker: ctx.preset.id,
      verifier: ctx.preset.id,
      scout: ctx.preset.id,
    });
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    await ctx.host.hooks.prepare(
      {
        request: {
          ...ctx.request,
          memberId: "scout-member",
          backendAgentId: "scout-agent",
          recipient: { ...ctx.request.recipient, role: "scout" },
        },
      },
      ctx.context,
    );
    admitPreparedChoices(ctx);
    const task = ctx.store.tasks.setRoleSelections("workspace", { scout: { mode: "disabled" } });
    await expect(ctx.host.resolveRecipient(task, "scout")).rejects.toThrow("未启用");
    expect(
      (await ctx.host.resolveRecipient(task, "scout", { memberId: "scout-member" })).config.model,
    ).toBe("cheap");
  });
  it("keeps an admitted native bootstrap planner when no planner default exists", async () => {
    const ctx = setup(false);
    const request = {
      ...ctx.request,
      recipient: {
        role: "planner",
        config: { ...ctx.request.recipient.config, model: "native-bootstrap" },
      },
    };
    expect((await ctx.host.hooks.prepare({ request }, ctx.context))?.ready).toBe(true);
    admitPreparedChoices(ctx);
    expect(
      (await ctx.host.resolveRecipient(ctx.store.tasks.get("workspace")!, "planner")).config.model,
    ).toBe("native-bootstrap");
    const next = ctx.store.presets.create({
      name: "真实默认",
      provider: "codex",
      model: "configured",
    });
    ctx.store.modelDefaults.setGlobal({ planner: next.id, worker: next.id, verifier: next.id });
    expect(
      (await ctx.host.resolveRecipient(ctx.store.tasks.get("workspace")!, "planner")).config.model,
    ).toBe("configured");
  });
  it("freezes actual preset candidates and environment for continuation after deletion", async () => {
    const ctx = setup();
    const task = await confirmHost(ctx);
    const override = ctx.store.presets.create({
      name: "实际覆盖",
      provider: "codex",
      model: "first",
      models: [
        { provider: "codex", model: "first", thinking: "low", permissionMode: "auto" },
        { provider: "codex", model: "second", thinking: "medium", permissionMode: "accept-edits" },
      ],
      runtimeEnv: "原运行环境",
      instructions: "原附加指令",
    });
    const request = {
      ...ctx.request,
      backendAgentId: "override-agent",
      memberId: "override-member",
      recipient: {
        role: "worker",
        presetId: override.id,
        config: {
          provider: "codex" as const,
          model: "first",
          thinkingOptionId: "low",
          cwd: process.cwd(),
        },
      },
    };
    expect((await ctx.host.hooks.prepare({ request }, ctx.context))?.ready).toBe(true);
    const runtime = createTaskRuntimeCommands(ctx.db);
    const old = runtime.registerSession({
      workspaceId: "workspace",
      agentId: "override-agent",
      role: "worker",
      provider: "codex",
      model: "first",
      thinking: "low",
      candidateIndex: 0,
      confirmedAt: task.confirmedAt,
    });
    ctx.store.presets.update(override.id, {
      models: [{ provider: "codex", model: "changed", thinking: "", permissionMode: "full" }],
      runtimeEnv: "新环境",
      instructions: "新指令",
    });
    ctx.store.presets.delete(override.id);
    const recipient = await ctx.host.resolveRecipient(ctx.store.tasks.get("workspace")!, "worker", {
      fromSessionId: old.id,
      candidateIndex: 1,
      memberId: "next-member",
    });
    expect(recipient.config).toMatchObject({
      provider: "codex",
      model: "second",
      thinkingOptionId: "medium",
    });
    expect(recipient.env?.VIBE_RUNTIME_ENV).toBe("原运行环境");
    const prepared = await ctx.host.hooks.prepare(
      {
        request: {
          ...ctx.request,
          backendAgentId: "next-agent",
          memberId: "next-member",
          recipient,
        },
      },
      ctx.context,
    );
    expect(prepared?.ready).toBe(true);
    expect(prepared?.config?.systemPrompt).toContain("原附加指令");
    expect(prepared?.config?.systemPrompt).not.toContain("新指令");
    expect(ctx.store.tasks.get("workspace")?.rolesSnapshot?.worker.models[0]?.model).toBe("cheap");
  });
  it("accepts a native model choice while retaining preset permissions and environment", async () => {
    const ctx = setup();
    ctx.store.presets.update(ctx.preset.id, {
      models: [{ provider: "codex", model: "cheap", thinking: "", permissionMode: "accept-edits" }],
      runtimeEnv: "受限环境",
      instructions: "不得扩大范围",
    });
    await confirmHost(ctx);
    const request = {
      ...ctx.request,
      backendAgentId: "native-worker",
      memberId: "native-member",
      recipient: {
        role: "worker",
        config: {
          provider: "codex" as const,
          model: "native-choice",
          thinkingOptionId: "low",
          cwd: process.cwd(),
          modeId: "full-access",
          providerOptions: { sandbox_mode: "danger-full-access" },
        },
      },
    };
    const prepared = await ctx.host.hooks.prepare({ request }, ctx.context);
    expect(prepared?.ready).toBe(true);
    expect(prepared?.config?.model).toBe("native-choice");
    expect(prepared?.config?.modeId).not.toBe("full-access");
    expect(prepared?.config?.providerOptions?.sandbox_mode).not.toBe("danger-full-access");
    expect(prepared?.env?.VIBE_RUNTIME_ENV).toBe("受限环境");
    const choices = ctx.store.tasks.get("workspace")?.control?.actualModels as Array<{
      agentId: string;
      presetSnapshot: { models: Array<{ model: string; permissionMode: string }> };
    }>;
    expect(
      choices.find((choice) => choice.agentId === "native-worker")?.presetSnapshot.models,
    ).toEqual([
      {
        provider: "codex",
        model: "native-choice",
        thinking: "low",
        permissionMode: "accept-edits",
      },
    ]);
  });
  it("repairs a rejected first attempt only from a real canonical planner source", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    ctx.canonical.anchorAgentId = "accepted-planner";
    ctx.members.push({
      memberId: "accepted-member",
      backendAgentId: "accepted-planner",
      role: "planner",
    });
    expect((await ctx.host.reconcileAnchor("workspace", "conversation")).anchorAgentId).toBe(
      "planner-agent",
    );
    ctx.sourceState.row = {
      kind: "assistant",
      completed: true,
      speaker: { role: "planner" },
      source: { memberId: "accepted-member", backendAgentId: "accepted-planner" },
    };
    const repaired = await ctx.host.reconcileAnchor("workspace", "conversation");
    expect(repaired.anchorAgentId).toBe("accepted-planner");
    expect(repaired.confirmedAt).toBeNull();
  });
  it("blocks new preparation and compact admission during execution source confirmation", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    ctx.store.tasks.updateControl("workspace", { confirmingRequestId: "confirming" });
    expect((await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context))?.reason).toBe(
      "正在核对执行方案，请稍后重试",
    );
    expect(
      (
        await ctx.host.hooks.admit(
          { request: { ...ctx.request, operation: "compact", admitted: false } },
          ctx.context,
        )
      )?.reason,
    ).toBe("正在核对执行方案，请稍后重试");
    expect(
      ctx.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .get()?.n,
    ).toBe(0);
  });
  it("binds the first planner and enforces provider read-only independently of the prompt", async () => {
    const ctx = setup();
    const prepared = await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    expect(prepared?.ready).toBe(true);
    expect(prepared?.config?.modeId).toBe("auto");
    expect(prepared?.config?.providerOptions).toMatchObject({
      sandbox_mode: "read-only",
      approval_policy: "never",
    });
    expect(ctx.store.tasks.get("workspace")).toMatchObject({
      conversationId: "conversation",
      anchorAgentId: "planner-agent",
      phase: "planning",
    });
    expect(prepared?.context).toContain("内部上下文");
    expect(prepared?.config?.systemPrompt).toContain("vibe-plan");
  });
  it("permits initial planning before execution defaults exist", async () => {
    const ctx = setup(false);
    const prepared = await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    expect(prepared?.ready).toBe(true);
    await expect(ctx.host.resolveRoles(ctx.store.tasks.get("workspace")!)).rejects.toThrow(
      "未配置",
    );
  });
  it("remembers a planner selected in the composer without authorizing execution", async () => {
    const ctx = setup();
    const other = ctx.store.presets.create({ name: "新规划", provider: "codex", model: "second" });
    const request = {
      ...ctx.request,
      recipient: {
        ...ctx.request.recipient,
        presetId: other.id,
        config: { ...ctx.request.recipient.config, model: "second" },
      },
    };
    expect((await ctx.host.hooks.prepare({ request }, ctx.context))?.ready).toBe(true);
    const task = ctx.store.tasks.get("workspace")!;
    expect(task.roleSelections?.planner).toEqual({ mode: "preset", presetId: other.id });
    expect(task.confirmedAt).toBeNull();
    expect((await ctx.host.resolveRoles(task)).planner.presetId).toBe(other.id);
  });
  it("retains caller fixed format instructions while forcing read-only sandbox", async () => {
    const ctx = setup();
    const request = {
      ...ctx.request,
      recipient: {
        ...ctx.request.recipient,
        config: {
          ...ctx.request.recipient.config,
          systemPrompt: "固定报告格式：必须输出 evidence 引用。",
        },
      },
    };
    const first = await ctx.host.hooks.prepare({ request }, ctx.context);
    expect(first?.config?.systemPrompt).toContain("固定报告格式");
    expect(first?.config?.providerOptions?.sandbox_mode).toBe("read-only");
    const second = await ctx.host.hooks.prepare(
      { request: { ...request, recipient: { ...request.recipient, config: first!.config! } } },
      ctx.context,
    );
    expect(second?.config?.systemPrompt).toBe(first?.config?.systemPrompt);
  });
  it("rejects worker selection before explicit confirmation without requesting resources", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    const input = { ...ctx.request, recipient: { ...ctx.request.recipient, role: "worker" } };
    expect((await ctx.host.hooks.prepare({ request: input }, ctx.context))?.ready).toBe(false);
    const admitted = await ctx.host.hooks.admit(
      { request: { ...input, operation: "send", admitted: false } },
      ctx.context,
    );
    expect(admitted?.admitted).toBe(false);
    expect(
      ctx.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .get()?.n,
    ).toBe(0);
  });
  it("rejects direct subagent send without delegation or with incomplete dependencies", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    const subtask = (id: string, dependsOn: string[]) => ({
      id,
      dependsOn,
      goal: id,
      method: "实现",
      notes: "",
      files: [id + ".ts"],
      acceptance: "通过测试",
    });
    const plan = {
      goal: "目标",
      approach: "做法",
      files: ["a.ts", "b.ts"],
      checks: [{ text: "检查", method: "测试" }],
      subtasks: [subtask("a", []), subtask("b", ["a"])],
    };
    const roles = await ctx.host.resolveRoles(ctx.store.tasks.get("workspace")!);
    const confirmed = ctx.store.tasks.confirm("workspace", {
      plan,
      rolesSnapshot: roles,
      planSource: {
        conversationId: "conversation",
        sourceKey: "plan",
        memberId: "planner-member",
        backendAgentId: "planner-agent",
      },
    });
    ctx.store.tasks.setPhase("workspace", "executing");
    ctx.store.tasks.setSubtaskRun("workspace", { subtaskId: "b", state: "pending" });
    ctx.members.push({ memberId: "worker-member", backendAgentId: "worker-agent", role: "worker" });
    const request = {
      ...ctx.request,
      memberId: "child-member",
      backendAgentId: "child-agent",
      recipient: {
        ...ctx.request.recipient,
        role: "subagent",
        parentMemberId: "worker-member",
        env: { VIBE_SUBTASK_ID: "b" },
      },
    };
    expect((await ctx.host.hooks.prepare({ request }, ctx.context))?.reason).toContain("正式委派");
    ctx.store.tasks.updateControl("workspace", {
      delegations: {
        b: {
          memberId: "child-member",
          parentMemberId: "worker-member",
          confirmedAt: confirmed.confirmedAt,
        },
      },
    });
    expect((await ctx.host.hooks.prepare({ request }, ctx.context))?.reason).toContain("前置依赖");
    const admitted = await ctx.host.hooks.admit(
      { request: { ...request, operation: "send", admitted: false } },
      ctx.context,
    );
    expect(admitted?.admitted).toBe(false);
    ctx.store.tasks.setSubtaskRun("workspace", { subtaskId: "a", state: "completed" });
    ctx.store.tasks.setSubtaskRun("workspace", {
      subtaskId: "b",
      state: "waiting",
      agentId: "child-agent",
      actualModel: { provider: "codex", model: "cheap" },
    });
    const followup = { ...request, recipient: { ...request.recipient, env: undefined } };
    const prepared = await ctx.host.hooks.prepare({ request: followup }, ctx.context);
    expect(prepared?.ready).toBe(true);
    expect(prepared?.env?.VIBE_SUBTASK_ID).toBe("b");
    expect(
      (
        await ctx.host.hooks.prepare(
          { request: { ...followup, backendAgentId: "unregistered-child" } },
          ctx.context,
        )
      )?.ready,
    ).toBe(false);
    ctx.store.tasks.setSubtaskRun("workspace", { subtaskId: "b", state: "completed" });
    expect((await ctx.host.hooks.prepare({ request }, ctx.context))?.reason).toContain("已经完成");
  });
  it("uses task selections before project/global defaults and freezes confirmed model permissions", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    const chosen = ctx.store.presets.create({
      name: "临时",
      provider: "codex",
      model: "chosen",
      runtimeEnv: "隔离环境",
      instructions: "附加约束",
    });
    const task = ctx.store.tasks.setRoleSelections("workspace", {
      planner: { mode: "preset", presetId: chosen.id },
    });
    const roles = await ctx.host.resolveRoles(task);
    expect(roles.planner.presetId).toBe(chosen.id);
    expect(roles.planner.source).toBe("task");
    const recipient = recipientFromPreset("planner", roles.planner, process.cwd());
    expect(recipient.config.providerOptions?.sandbox_mode).toBe("read-only");
    expect(recipient.env?.VIBE_RUNTIME_ENV).toBe("隔离环境");
    const prepared = await ctx.host.hooks.prepare(
      {
        request: {
          ...ctx.request,
          memberId: "new-planner-member",
          backendAgentId: "new-planner-agent",
          recipient,
        },
      },
      ctx.context,
    );
    expect(prepared?.config?.systemPrompt).toContain("运行环境要求\n隔离环境");
    expect(prepared?.config?.systemPrompt).toContain("附加约束");
  });
  it("retains all resources after an unknown stop", async () => {
    const ctx = setup();
    const before = ctx.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM vibe_event").get()!.n;
    await ctx.host.hooks.beforeControl?.(
      {
        request: {
          conversationId: "conversation",
          workspaceId: "workspace",
          ownerPluginId: "vibe-board",
          action: "stop",
          phase: "unknown",
        },
      },
      ctx.context,
    );
    expect(ctx.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM vibe_event").get()!.n).toBe(
      before,
    );
  });
  it("keeps compact control separate from task execution and confirmation", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    const confirmed = ctx.store.tasks.confirm("workspace", {
      plan: {
        goal: "目标",
        approach: "做法",
        files: [],
        subtasks: [],
        checks: [{ text: "检查", method: "测试" }],
      },
      rolesSnapshot: await ctx.host.resolveRoles(ctx.store.tasks.get("workspace")!),
      planSource: {
        conversationId: "conversation",
        sourceKey: "plan",
        memberId: "planner-member",
        backendAgentId: "planner-agent",
      },
    });
    ctx.store.tasks.setPhase("workspace", "executing");
    const request = {
      conversationId: "conversation",
      workspaceId: "workspace",
      ownerPluginId: "vibe-board",
      action: "compact" as const,
      backendAgentId: "planner-agent",
    };
    await ctx.host.hooks.beforeControl?.({ request: { ...request, phase: "before" } }, ctx.context);
    expect(ctx.host.isCompacting("planner-agent")).toBe(true);
    expect(
      ctx.db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .get()?.n,
    ).toBe(0);
    await ctx.host.hooks.beforeControl?.(
      { request: { ...request, phase: "unknown" } },
      ctx.context,
    );
    expect(ctx.store.tasks.get("workspace")).toMatchObject({
      phase: "executing",
      confirmedAt: confirmed.confirmedAt,
      control: { compactUnknown: true },
    });
    expect(ctx.host.isCompacting("planner-agent")).toBe(true);
    await ctx.host.hooks.beforeControl?.(
      { request: { ...request, backendAgentId: "other-member", phase: "unknown" } },
      ctx.context,
    );
    await ctx.host.hooks.beforeControl?.(
      { request: { ...request, phase: "settled" } },
      ctx.context,
    );
    expect(ctx.store.tasks.get("workspace")?.control?.compactUnknown).toBe(true);
    expect(ctx.host.isCompacting("planner-agent")).toBe(false);
    expect(ctx.host.isCompacting("other-member")).toBe(true);
    await ctx.host.hooks.beforeControl?.(
      { request: { ...request, backendAgentId: "other-member", phase: "settled" } },
      ctx.context,
    );
    expect(ctx.store.tasks.get("workspace")).toMatchObject({
      phase: "executing",
      confirmedAt: confirmed.confirmedAt,
      control: { compactUnknown: false, blockingReason: "" },
    });
    expect(ctx.host.isCompacting("other-member")).toBe(false);
  });
  it("does not relink a historical member to a new confirmation while compacting", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    const runtime = createTaskRuntimeCommands(ctx.db);
    const session = runtime.registerSession({
      workspaceId: "workspace",
      agentId: "old-worker",
      role: "worker",
      provider: "codex",
      model: "cheap",
      candidateIndex: 0,
      confirmedAt: "2026-10-22T00:00:00.000Z",
    });
    const actualModelsBefore = ctx.store.tasks.get("workspace")?.control?.actualModels;
    const timer = setInterval(() => {
      for (const row of ctx.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .all()) {
        const input = JSON.parse(row.payload_json);
        publishEvent(ctx.db, {
          type: "scheduler.task_resource_result",
          payload: {
            ...input,
            reservationId: input.reservationId ?? "compact",
            ok: true,
            reason: "已准入",
            provider: "codex",
            model: "cheap",
          },
          dedupeKey: "test-result:" + input.requestId,
        });
      }
    }, 1);
    try {
      const admitted = await ctx.host.hooks.admit(
        {
          request: {
            ...ctx.request,
            backendAgentId: "old-worker",
            memberId: "old-worker-member",
            recipient: { ...ctx.request.recipient, role: "worker" },
            operation: "compact",
            admitted: false,
          },
        },
        ctx.context,
      );
      expect(admitted?.admitted).toBe(true);
      expect(runtime.getSession(session.id)?.confirmedAt).toBe("2026-10-22T00:00:00.000Z");
      expect(ctx.store.tasks.get("workspace")?.confirmedAt).toBeNull();
      expect(ctx.store.tasks.get("workspace")?.control?.actualModels).toEqual(actualModelsBefore);
    } finally {
      clearInterval(timer);
    }
  });
  it("replaces a stale scheduler summary when stop is settled and suppresses auto continuation", async () => {
    const ctx = setup();
    await ctx.host.hooks.prepare({ request: ctx.request }, ctx.context);
    ctx.store.tasks.setSummary("workspace", "等待原生停止，资源继续保留");
    for (const backendAgentId of ["planner-agent", "worker-agent"])
      await ctx.host.hooks.beforeControl?.(
        {
          request: {
            conversationId: "conversation",
            workspaceId: "workspace",
            ownerPluginId: "vibe-board",
            action: "compact",
            phase: "before",
            backendAgentId,
          },
        },
        ctx.context,
      );
    const timer = setInterval(() => {
      const rows = ctx.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .all();
      for (const row of rows) {
        const input = JSON.parse(row.payload_json);
        publishEvent(ctx.db, {
          type: "scheduler.task_resource_result",
          payload: { ...input, ok: true, reason: "已核对" },
          dedupeKey: "test-result:" + input.requestId,
        });
      }
    }, 1);
    try {
      await ctx.host.hooks.beforeControl?.(
        {
          request: {
            conversationId: "conversation",
            workspaceId: "workspace",
            ownerPluginId: "vibe-board",
            action: "stop",
            phase: "settled",
            backendAgentId: "planner-agent",
          },
        },
        ctx.context,
      );
      expect(ctx.store.tasks.get("workspace")).toMatchObject({
        phase: "paused",
        summary: "任务成员已停止；等待显式接续或重新制定方案",
        control: { autoContinuationBlocked: true },
      });
      expect(ctx.host.isCompacting("planner-agent")).toBe(false);
      expect(ctx.host.isCompacting("worker-agent")).toBe(false);
    } finally {
      clearInterval(timer);
    }
  });
  it("registers fixed execution formats for direct handover and continuation", () => {
    const ctx = setup();
    ctx.store.prompts.setOverride("task.role.worker", "自定义执行规则");
    expect(ctx.store.prompts.resolve("task.role.worker")).toContain("vibe-delegate");
    expect(ctx.store.prompts.resolve("task.role.worker")).toContain("vibe-delivery");
    expect(ctx.store.prompts.resolve("task.role.subagent")).toContain("vibe-delivery");
  });
});

describe("scheduler transport", () => {
  it.each(["before_bind", "bind_pending"] as const)(
    "keeps a new admission leased when an old turn ends during %s",
    async (gate) => {
      const ctx = setup();
      const resources = createTaskResources(ctx.db, 1000);
      const entered = barrier();
      const resume = barrier();
      const answered = new Set<string>();
      const requests = new Map<string, { action: string }>();
      const held = new Set<string>();
      let bindCount = 0;
      let allowBind = false;
      const timer = setInterval(() => {
        for (const row of ctx.db
          .prepare<{ payload_json: string }>(
            "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
          )
          .all()) {
          const input = JSON.parse(row.payload_json);
          if (!requests.has(input.requestId) && input.action === "bind") bindCount++;
          requests.set(input.requestId, input);
          if (answered.has(input.requestId)) continue;
          if (input.action === "bind" && bindCount === 2 && gate === "bind_pending" && !allowBind) {
            entered.open();
            continue;
          }
          answered.add(input.requestId);
          const reservationId = input.reservationId ?? input.requestId;
          if (input.action === "acquire") held.add(reservationId);
          if (input.action === "release") held.delete(reservationId);
          publishEvent(ctx.db, {
            type: "scheduler.task_resource_result",
            payload: {
              ...input,
              reservationId,
              ok: input.action !== "bind" || held.has(reservationId),
              reason: "已核对",
              provider: "codex",
              model: "cheap",
            },
          });
        }
      }, 1);
      try {
        const input = { workspaceId: "workspace", role: "verifier" as const, agentId: "verifier" };
        await resources.admit(input, null);
        resources.noteTurnStarted("verifier", "turn1");
        const followup = resources.admit(input, null, async () => {
          if (gate === "before_bind") {
            entered.open();
            await resume.promise;
          }
        });
        await entered.promise;
        const old = resources.takeTurn("verifier", "turn1")!;
        expect(old.isCurrent()).toBe(false);
        await old.release();
        allowBind = true;
        resume.open();
        const result = await followup;
        expect(result.ok).toBe(true);
        expect(held.has(result.reservationId!)).toBe(true);
        expect([...requests.values()].map((request) => request.action)).toEqual([
          "acquire",
          "bind",
          "bind",
        ]);
        resources.noteTurnStarted("verifier", "turn2");
        expect(resources.takeTurn("verifier", null)).toBeUndefined();
        expect(resources.takeTurn("verifier", "turn1")).toBeUndefined();
        await old.release();
        expect(held.has(result.reservationId!)).toBe(true);
        const current = resources.takeTurn("verifier", "turn2")!;
        expect(current.isCurrent()).toBe(true);
        expect(resources.takeTurn("verifier", "turn2")).toBeUndefined();
        await current.release();
        expect(held.size).toBe(0);
        expect(current.isCurrent()).toBe(true);
        await resources.admit(input, null, undefined, "same-client-message");
        resources.noteTurnStarted("verifier", "retried-turn");
        await resources.admit(input, null, undefined, "same-client-message");
        const retried = resources.takeTurn("verifier", "retried-turn")!;
        expect(retried.isCurrent()).toBe(true);
        await resources.settled("workspace");
        expect(retried.isCurrent()).toBe(false);
        expect(current.isCurrent()).toBe(false);
      } finally {
        clearInterval(timer);
      }
    },
  );
  it.each([true, false])(
    "settles a rejected generation on an old bound lease only after native stop is confirmed: %s",
    async (releaseConfirmed) => {
      const ctx = setup();
      const resources = createTaskResources(ctx.db, 1000);
      const requests = new Map<string, { action: string }>();
      let allowRelease = releaseConfirmed;
      const timer = setInterval(() => {
        for (const row of ctx.db
          .prepare<{ payload_json: string }>(
            "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
          )
          .all()) {
          const input = JSON.parse(row.payload_json);
          if (requests.has(input.requestId)) continue;
          requests.set(input.requestId, input);
          publishEvent(ctx.db, {
            type: "scheduler.task_resource_result",
            payload: {
              ...input,
              reservationId: input.reservationId ?? "existing",
              ok: input.action !== "release" || allowRelease,
              reason: allowRelease ? "已停止" : "停止未确认",
              provider: "codex",
              model: "cheap",
            },
          });
        }
      }, 1);
      try {
        const input = { workspaceId: "workspace", role: "verifier" as const, agentId: "verifier" };
        await resources.admit(input, null);
        resources.noteTurnStarted("verifier", "old-turn");
        await expect(
          resources.admit(input, null, () => {
            throw new Error("本轮登记被拒绝");
          }),
        ).rejects.toThrow(releaseConfirmed ? "本轮登记被拒绝" : "资源释放未确认");
        const old = resources.takeTurn("verifier", "old-turn")!;
        expect(old.isCurrent()).toBe(false);
        await old.release();
        allowRelease = true;
        await resources.settled("workspace");
        expect(
          [...requests.values()].filter((request) => request.action === "release"),
        ).toHaveLength(releaseConfirmed ? 1 : 2);
      } finally {
        clearInterval(timer);
      }
    },
  );
  it("waits for an in-flight completed-turn release before acquiring a follow-up lease", async () => {
    const ctx = setup();
    const resources = createTaskResources(ctx.db, 1000);
    const requests = new Map<string, { action: string }>();
    const answered = new Set<string>();
    let allowRelease = false;
    const timer = setInterval(() => {
      for (const row of ctx.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .all()) {
        const input = JSON.parse(row.payload_json);
        requests.set(input.requestId, input);
        if (answered.has(input.requestId) || (input.action === "release" && !allowRelease))
          continue;
        answered.add(input.requestId);
        publishEvent(ctx.db, {
          type: "scheduler.task_resource_result",
          payload: {
            ...input,
            reservationId: input.reservationId ?? input.requestId,
            ok: true,
            reason: "已确认",
            provider: "codex",
            model: "cheap",
          },
        });
      }
    }, 1);
    try {
      const input = { workspaceId: "workspace", role: "verifier" as const, agentId: "verifier" };
      await resources.admit(input, null);
      const released = resources.releaseAgent("workspace", "verifier");
      const followup = resources.admit(input, null);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect([...requests.values()].map((request) => request.action)).toEqual([
        "acquire",
        "bind",
        "release",
      ]);
      allowRelease = true;
      await Promise.all([released, followup]);
      expect([...requests.values()].map((request) => request.action)).toEqual([
        "acquire",
        "bind",
        "release",
        "acquire",
        "bind",
      ]);
    } finally {
      clearInterval(timer);
    }
  });
  it.each([true, false])(
    "reclaims a rejected pending admission while retaining unconfirmed release: %s",
    async (releaseConfirmed) => {
      const ctx = setup();
      const resources = createTaskResources(ctx.db, 1000);
      const confirmedAt = "2026-10-23T00:00:00.000Z";
      resources.handleAdmission({
        type: "scheduler.task_admitted",
        payload: {
          workspaceId: "workspace",
          confirmedAt,
          role: "worker",
          reservationId: "reserved",
          presetId: "preset",
          provider: "codex",
          model: "cheap",
          port: 17115,
          deviceIds: [],
        },
        seq: 1,
        ts: confirmedAt,
        cardId: null,
        projectId: null,
        dedupeKey: null,
      });
      const requests = new Map<string, { action: string; reservationId?: string }>();
      let allowRelease = releaseConfirmed;
      const timer = setInterval(() => {
        for (const row of ctx.db
          .prepare<{ payload_json: string }>(
            "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
          )
          .all()) {
          const input = JSON.parse(row.payload_json);
          if (requests.has(input.requestId)) continue;
          requests.set(input.requestId, input);
          publishEvent(ctx.db, {
            type: "scheduler.task_resource_result",
            payload: {
              ...input,
              ok: input.action !== "release" || allowRelease,
              reason: allowRelease ? "已确认" : "原生停止待核对",
              reservationId: input.reservationId ?? "fresh",
              provider: "codex",
              model: "cheap",
            },
          });
        }
      }, 1);
      try {
        const input = { workspaceId: "workspace", role: "worker" as const, agentId: "worker" };
        await expect(
          resources.admit(input, confirmedAt, () => {
            throw new Error("恢复失败");
          }),
        ).rejects.toThrow(releaseConfirmed ? "恢复失败" : "资源释放未确认");
        expect([...requests.values()]).toEqual([
          expect.objectContaining({ action: "release", reservationId: "reserved" }),
        ]);
        expect(resources.admissionFor("workspace")?.reservationId).toBe(
          releaseConfirmed ? undefined : "reserved",
        );
        allowRelease = true;
        await resources.settled("workspace");
        expect(
          [...requests.values()].filter((request) => request.action === "release"),
        ).toHaveLength(releaseConfirmed ? 1 : 2);
        expect(resources.admissionFor("workspace")).toBeUndefined();
        await resources.admit(input, confirmedAt);
        expect([...requests.values()].slice(-2).map((request) => request.action)).toEqual([
          "acquire",
          "bind",
        ]);
      } finally {
        clearInterval(timer);
      }
    },
  );
  it("binds a first worker reservation without reacquiring and releases only after settled", async () => {
    const ctx = setup();
    const resources = createTaskResources(ctx.db, 1000);
    resources.handleAdmission({
      type: "scheduler.task_admitted",
      payload: {
        workspaceId: "workspace",
        confirmedAt: "2026-10-23T00:00:00.000Z",
        role: "worker",
        reservationId: "reserved",
        presetId: "preset",
        provider: "codex",
        model: "cheap",
        port: 17115,
        deviceIds: [],
      },
      seq: 1,
      ts: "2026-10-23T00:00:00.000Z",
      cardId: null,
      projectId: null,
      dedupeKey: null,
    });
    const handled = new Set<string>();
    const actions: string[] = [];
    const timer = setInterval(() => {
      for (const row of ctx.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request'",
        )
        .all()) {
        const input = JSON.parse(row.payload_json);
        if (handled.has(input.requestId)) continue;
        handled.add(input.requestId);
        actions.push(input.action);
        publishEvent(ctx.db, {
          type: "scheduler.task_resource_result",
          payload: {
            ...input,
            reservationId: input.reservationId ?? "lease:" + input.role,
            ok: true,
            reason: "已确认",
            provider: "codex",
            model: "cheap",
          },
        });
      }
    }, 1);
    try {
      await resources.admit(
        { workspaceId: "workspace", role: "worker", agentId: "worker" },
        "2026-10-23T00:00:00.000Z",
      );
      expect(actions).toEqual(["bind"]);
      await resources.admit(
        { workspaceId: "workspace", role: "planner", agentId: "planner" },
        null,
      );
      await Promise.all([
        resources.releaseAgent("workspace", "worker"),
        resources.releaseAgent("workspace", "worker"),
      ]);
      expect(actions).toEqual(["bind", "acquire", "bind", "release"]);
      const released = ctx.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'scheduler.task_resource_request' AND json_extract(payload_json, '$.action') = 'release'",
        )
        .all();
      expect(released.map((row) => JSON.parse(row.payload_json).agentId)).toEqual(["worker"]);
      await resources.settled("workspace");
      expect(actions).toEqual(["bind", "acquire", "bind", "release", "release", "reconcile"]);
      await resources.admit(
        { workspaceId: "workspace", role: "worker", agentId: "worker" },
        "2026-10-23T00:00:00.000Z",
      );
      expect(actions.slice(-2)).toEqual(["acquire", "bind"]);
    } finally {
      clearInterval(timer);
    }
  });
});
