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
    card: { id: "c1", key: "DEMO-1" },
    project: {},
    provider: "codex",
    cwd: "/x",
    workspaceId: null,
    outputDir: "/o",
    ...extra,
  }) as any;

describe("verifier launcher model handling", () => {
  it("skips unavailable models during creation and reports exhausted candidates", async () => {
    const f = fakePaseo([]);
    f.paseo.agents.create = async (options: any) => {
      f.created.push(options);
      throw new Error("provider not installed");
    };
    await expect(
      createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
        input({
          preset: {
            models: [
              { provider: "codex", model: "first" },
              { provider: "claude", model: "second" },
            ],
          },
        }),
      ),
    ).rejects.toThrow("预设中的模型均不可用");
    expect(f.created.map((c) => c.config.provider)).toEqual(["codex/first", "claude/second"]);
  });
  it("continues on the next preset model after authentication fails, retaining previous rounds", async () => {
    const runs: Array<{ spec: string; prompt: string }> = [];
    const replaced: string[] = [];
    let round = 0;
    const paseo = fakePaseo([]).paseo;
    paseo.agents.create = async (options: any) => ({
      run: async (prompt: string) => {
        runs.push({ spec: options.config.provider, prompt });
        return options.config.provider === "codex/first" && ++round > 1
          ? {
              status: "error",
              error: "authentication required",
              lastMessage: "",
            }
          : { status: "idle", lastMessage: "previous conclusion" };
      },
      archive: async () => {},
    });
    const agent = await createPaseoVerifierLauncher({
      getPaseo: () => paseo,
    }).launch(
      input({
        preset: {
          models: [
            {
              provider: "codex",
              model: "first",
              thinking: "",
              permissionMode: "auto",
            },
            {
              provider: "claude",
              model: "second",
              thinking: "",
              permissionMode: "auto",
            },
          ],
        },
        onReplacement: (next: { provider: string }) => replaced.push(next.provider),
      }),
    );
    await agent.run("prepare evidence");
    expect(await agent.run("judge evidence")).toMatchObject({ status: "idle" });
    expect(runs.map((r) => r.spec)).toEqual(["codex/first", "codex/first", "claude/second"]);
    expect(runs[2].prompt).toContain("prepare evidence");
    expect(runs[2].prompt).toContain("previous conclusion");
    expect(runs[2].prompt).toContain("judge evidence");
    expect(replaced).toEqual(["claude"]);
    expect(agent.provider).toBe("claude");
  });

  it("does not switch models for ordinary task failures", async () => {
    const f = fakePaseo([]);
    f.paseo.agents.create = async (options: any) => {
      f.created.push(options);
      return {
        run: async () => ({ status: "error", error: "test assertion failed" }),
        archive: async () => {},
      };
    };
    const agent = await createPaseoVerifierLauncher({
      getPaseo: () => f.paseo,
    }).launch(
      input({
        preset: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "claude", model: "second" },
          ],
        },
      }),
    );
    expect(await agent.run("review")).toMatchObject({
      status: "error",
      error: "test assertion failed",
    });
    expect(f.created).toHaveLength(1);
  });
  it("uses the preset model as is", async () => {
    const f = fakePaseo([]);
    const agent = await createPaseoVerifierLauncher({
      getPaseo: () => f.paseo,
    }).launch(input({ model: "gpt-5" }));
    expect(f.created[0].config.provider).toBe("codex/gpt-5");
    expect(agent.note).toBeUndefined();
  });

  it("fills a missing model with the provider default and reports it", async () => {
    const f = fakePaseo([{ id: "a" }, { id: "gpt-5-codex", isDefault: true }]);
    const agent = await createPaseoVerifierLauncher({
      getPaseo: () => f.paseo,
    }).launch(input({ role: "reviewer" }));
    expect(f.created[0].config.provider).toBe("codex/gpt-5-codex");
    expect(agent.note).toContain("gpt-5-codex");
  });

  it("refuses with a clear message when there is no default model", async () => {
    for (const models of [[], "throw"] as const) {
      const f = fakePaseo(models);
      await expect(
        createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(input()),
      ).rejects.toThrow(/没有默认模型/);
      expect(f.created).toHaveLength(0);
    }
  });
});

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
      card: undefined,
      task: { workspaceId: "ws", anchorAgentId: "anchor", conversationId: "conversation" },
      workspaceId: "ws",
      model: "first",
      ...extra,
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
