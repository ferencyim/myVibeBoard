import { describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { createPaseoVerifierLauncher } from "../server/verifier/agent";

function fakePaseo(models: Array<{ id: string; isDefault?: boolean }> | "throw") {
  const created: any[] = [];
  const paseo = {
    providers: {
      listModels: async () => {
        if (models === "throw") throw new Error("catalog down");
        return { models };
      },
    },
    agents: {
      create: async (options: any) => {
        created.push(options);
        return {
          run: async () => ({ status: "idle", lastMessage: "" }),
          archive: async () => {},
        };
      },
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (o: any) => (
            created.push(o), { run: async () => ({ status: "idle" }), archive: async () => {} }
          ),
        },
      }),
    },
  } as any;
  return { paseo, created };
}

const input = (extra: Record<string, unknown> = {}) =>
  ({
    task: { workspaceId: "ws", anchorAgentId: "anchor", conversationId: "conversation" },
    project: { id: "project" },
    provider: "codex",
    cwd: "/x",
    workspaceId: "ws",
    outputDir: "/o",
    ...extra,
  }) as any;

describe("原生任务群聊辅助成员", () => {
  function conversationPaseo(status = "accepted", firstUnavailable = false) {
    const f = fakePaseo([]);
    type Send = Parameters<ReturnType<PaseoApi["taskConversations"]["ref"]>["send"]>[0];
    const sends: Send[] = [];
    let activeTurn: unknown = null;
    let model = "first";
    f.paseo.agents.ref = (id: string) => ({
      id,
      refresh: async () => {},
      current: () => ({ provider: "codex", model }),
      status: "idle",
      get activeTurn() {
        return activeTurn;
      },
      waitForFinish: async () =>
        firstUnavailable && model === "first"
          ? { status: "error", error: "authentication required" }
          : { status: "idle", lastMessage: "完整验证结论" },
    });
    f.paseo.taskConversations = {
      ref: () => ({
        refresh: async () => ({
          workspaceId: "ws",
          members: [{ memberId: "planner", backendAgentId: "anchor" }],
        }),
        send: async (request: Send) => {
          sends.push(request);
          if (status === "throw") throw new Error("network error authentication required");
          model = request.recipient.config.model!;
          return {
            error: status === "unknown" ? "authentication required" : null,
            delivery: { status, memberId: "verifier", backendAgentId: "backend", error: null },
          };
        },
        querySource: async () => ({
          error: null,
          row: {
            sourceKey: "model-output",
            source: { memberId: "verifier", backendAgentId: "backend", sourceTurnId: "turn" },
          },
        }),
      }),
    };
    return {
      ...f,
      sends,
      busy: (value: unknown) => {
        activeTurn = value;
      },
    };
  }
  const taskInput = (extra = {}) =>
    input({
      task: { workspaceId: "ws", anchorAgentId: "anchor", conversationId: "conversation" },
      workspaceId: "ws",
      model: "first",
      ...extra,
    });

  it("拒绝缺少任务定位或使用其他 workspace 的请求", async () => {
    const f = conversationPaseo();
    const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo });
    await expect(launcher.launch(taskInput({ task: undefined }))).rejects.toThrow(
      "缺少任务群聊定位",
    );
    await expect(launcher.launch(taskInput({ workspaceId: "other" }))).rejects.toThrow(
      "必须使用任务原生 workspace",
    );
    expect(f.created).toHaveLength(0);
    expect(f.sends).toHaveLength(0);
  });
  it("按候选顺序跳过创建时不可用的 provider，全部不可用时明确报错", async () => {
    const f = conversationPaseo();
    const providers: string[] = [];
    f.paseo.taskConversations.ref = () => ({
      refresh: async () => {
        throw new Error("provider not installed");
      },
    });
    f.paseo.providers.listModels = async (provider: string) => {
      providers.push(provider);
      return { models: [{ id: "default", isDefault: true }] };
    };
    await expect(
      createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
        taskInput({
          model: undefined,
          snapshot: { models: [{ provider: "codex" }, { provider: "claude" }] },
        }),
      ),
    ).rejects.toThrow("预设中的模型均不可用");
    expect(providers).toEqual(["codex", "claude"]);
    expect(f.created).toHaveLength(0);
  });
  it("使用预设模型，并为缺失模型解析 provider 默认模型", async () => {
    const f = conversationPaseo();
    f.paseo.providers.listModels = async () => ({ models: [{ id: "default", isDefault: true }] });
    const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo });
    const explicit = await launcher.launch(taskInput({ model: "explicit" }));
    await explicit.run("复核");
    expect(explicit.note).toBeUndefined();
    const fallback = await launcher.launch(taskInput({ model: undefined }));
    await fallback.run("复核");
    expect(f.sends.map((send) => send.recipient.config.model)).toEqual(["explicit", "default"]);
    expect(fallback.note).toContain("默认模型 default");
  });
  it("无可用默认模型时明确拒绝", async () => {
    const f = conversationPaseo();
    for (const models of [[], "throw"] as const) {
      f.paseo.providers = fakePaseo(models).paseo.providers;
      await expect(
        createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
          taskInput({ model: undefined }),
        ),
      ).rejects.toThrow("没有默认模型");
    }
    expect(f.sends).toHaveLength(0);
  });
  it("普通任务失败不轮换候选模型", async () => {
    const f = conversationPaseo();
    const ref = f.paseo.agents.ref;
    f.paseo.agents.ref = (id: string) => ({
      ...ref(id),
      waitForFinish: async () => ({ status: "error", error: "test assertion failed" }),
    });
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({
        snapshot: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "claude", model: "second" },
          ],
        },
      }),
    );
    expect(await agent.run("复核")).toMatchObject({
      status: "error",
      error: "test assertion failed",
    });
    expect(f.sends).toHaveLength(1);
  });
  it("后续轮次模型登录失败时保留此前对话并按预设换模", async () => {
    const f = conversationPaseo();
    const ref = f.paseo.agents.ref;
    f.paseo.agents.ref = (id: string) => ({
      ...ref(id),
      waitForFinish: async () =>
        f.sends.length === 2
          ? { status: "error", error: "authentication required" }
          : { status: "idle", lastMessage: "此前结论" },
    });
    const replacements: string[] = [];
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({
        onReplacement: (next: { model: string }) => replacements.push(next.model),
        snapshot: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "codex", model: "second" },
          ],
        },
      }),
    );
    await agent.run("准备证据");
    expect(await agent.run("判断证据")).toMatchObject({ status: "idle" });
    expect(f.sends.map((send) => send.recipient.config.model)).toEqual([
      "first",
      "first",
      "second",
    ]);
    expect(f.sends[2].text).toContain("准备证据");
    expect(f.sends[2].text).toContain("此前结论");
    expect(f.sends[2].text).toContain("判断证据");
    expect(replacements).toEqual(["second"]);
  });
  it("Claude 辅助成员使用只读 plan 模式", async () => {
    const f = conversationPaseo();
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({ provider: "claude" }),
    );
    await agent.run("复核");
    expect(f.sends[0].recipient.config.modeId).toBe("plan");
  });
  it("实际模型无法核对时保留成员，不自动换模", async () => {
    const f = conversationPaseo();
    const ref = f.paseo.agents.ref;
    f.paseo.agents.ref = (id: string) => ({ ...ref(id), current: () => ({ provider: "codex" }) });
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput(),
    );
    await expect(agent.run("复核")).rejects.toThrow("无法核对验证会话实际模型");
    expect(f.sends).toHaveLength(1);
  });
  it("经宿主准入的群聊send启动，角色挂anchor并保留完整源定位，不创建独立tab或重复申请租约", async () => {
    const f = conversationPaseo();
    const selections: unknown[] = [];
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({
        onCreated: (value: unknown) => selections.push(value),
        acquire: async () => {
          throw new Error("不得双重准入");
        },
        snapshot: {
          presetId: "preset",
          instructions: "中文附加指令",
          models: [{ provider: "codex", model: "first" }],
        },
      }),
    );
    expect(f.created).toHaveLength(0);
    expect(await agent.run("核对证据")).toMatchObject({ status: "idle", text: "完整验证结论" });
    expect(f.sends[0].recipient.memberId).toBeUndefined();
    expect(f.sends[0]).toMatchObject({
      text: "核对证据",
      recipient: {
        role: "verifier",
        presetId: "preset",
        parentMemberId: "planner",
        config: {
          provider: "codex",
          model: "first",
          providerOptions: { sandbox_mode: "read-only", approval_policy: "never" },
        },
      },
    });
    expect(f.sends[0].recipient.config.systemPrompt).toContain("中文附加指令");
    expect(selections).toMatchObject([{ agentId: "backend", candidateIndex: 0, model: "first" }]);
    expect(agent.source).toMatchObject({
      sourceKey: "model-output",
      memberId: "verifier",
      sourceTurnId: "turn",
    });
    await agent.run("判断证据");
    expect(f.sends[1].recipient.memberId).toBe("verifier");
    f.busy({ id: "active" });
    await expect(agent.close()).rejects.toThrow("尚未停止");
    f.busy(null);
    await agent.close();
  });
  it.each(["reviewer", "verifier"] as const)(
    "%s receives confirmation and commit in its effective configuration to isolate stale private context",
    async (role) => {
      const f = conversationPaseo();
      const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo });
      for (const commitHash of ["commit-before", "commit-current"]) {
        const agent = await launcher.launch(
          taskInput({
            role,
            task: {
              workspaceId: "ws",
              anchorAgentId: "anchor",
              conversationId: "conversation",
              confirmedAt: "2030-01-01T00:00:00.000Z",
              commitHash,
            },
          }),
        );
        await agent.run("当前证据请求");
        await agent.close();
      }
      const prompts = f.sends.map((send) => send.recipient.config.systemPrompt);
      expect(f.sends.map((send) => send.recipient.env?.VIBE_VERIFICATION_COMMIT)).toEqual([
        "commit-before",
        "commit-current",
      ]);
      expect(prompts[0]).toContain("confirmedAt=2030-01-01T00:00:00.000Z");
      expect(prompts[0]).toContain("commit=commit-before");
      expect(prompts[1]).toContain("commit=commit-current");
      expect(prompts[1]).not.toContain("commit-before");
    },
  );

  it.each(["unknown", "throw"])("回执不明或传输失败不能重发或轮换候选模型：%s", async (status) => {
    const f = conversationPaseo(status);
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({
        snapshot: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "claude", model: "second" },
          ],
        },
      }),
    );
    await expect(agent.run("核对证据")).rejects.toThrow("禁止自动重发");
    expect(f.sends).toHaveLength(1);
  });
  it("确定完成的模型登录失败按冻结候选接续，继续使用同一任务群聊", async () => {
    const f = conversationPaseo("accepted", true);
    let previousSessionId: string | undefined;
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({
        previousSessionId: () => previousSessionId,
        onCreated: () => {
          previousSessionId = "previous-session";
        },
        snapshot: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "codex", model: "second" },
          ],
        },
      }),
    );
    expect(await agent.run("核对证据")).toMatchObject({ status: "idle" });
    expect(f.sends.map((send) => send.recipient.config.model)).toEqual(["first", "second"]);
    expect(f.sends[1].recipient.env?.VIBE_CANDIDATE_INDEX).toBe("1");
    expect(f.sends[0].recipient.env?.VIBE_PREVIOUS_SESSION_ID).toBeUndefined();
    expect(f.sends[1].recipient.env?.VIBE_PREVIOUS_SESSION_ID).toBe("previous-session");
    expect(f.sends[1].recipient.memberId).toEqual(expect.any(String));
    expect(f.sends[1].recipient.memberId).not.toBe("verifier");
    expect(f.created).toHaveLength(0);
    await agent.close();
  });
  it("跨确认失败重试显式新成员但不串旧轮，实际候选索引作为起点", async () => {
    const f = conversationPaseo();
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      taskInput({
        forceNewMember: true,
        candidateIndex: 1,
        snapshot: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "codex", model: "second" },
          ],
        },
      }),
    );
    await agent.run("重验");
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].recipient).toMatchObject({
      memberId: expect.any(String),
      parentMemberId: "planner",
      config: { model: "second" },
    });
    expect(f.sends[0].recipient.env?.VIBE_CANDIDATE_INDEX).toBe("1");
    expect(f.sends[0].recipient.env?.VIBE_PREVIOUS_SESSION_ID).toBeUndefined();
    await agent.close();
  });
});
