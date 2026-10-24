import { describe, expect, it } from "vitest";
import {
  createPaseoVerifierLauncher,
  nativeConfig,
  type LaunchInput,
} from "../server/verifier/agent";

interface CreateOptions {
  config: {
    provider: string;
    modeId?: string;
    options?: Record<string, unknown>;
    systemPrompt?: string;
  };
  env?: Record<string, string>;
  labels?: Record<string, string>;
  title?: string;
}

interface WaitResult {
  status: "idle" | "error" | "permission" | "timeout";
  lastMessage?: string;
  error?: string;
}

interface FakeHandle {
  id: string;
  refresh(): Promise<void>;
  current(): { provider: string; model?: string; thinkingOptionId?: string };
  readonly status: string;
  readonly activeTurn: unknown;
  send(text: string, options?: { sourceAgentId?: string }): Promise<void>;
  waitForFinish(ms: number): Promise<WaitResult>;
  timeline: {
    refetch(input: { direction: "tail"; limit: number }): Promise<{
      epoch: string;
      entries: Array<{ item: { type: string; messageId?: string }; turnId?: string; seqEnd: number }>;
    }>;
  };
}

function fakePaseo() {
  const created: CreateOptions[] = [];
  const sends: Array<{ agentId: string; text: string; options?: { sourceAgentId?: string } }> =
    [];
  const handles: FakeHandle[] = [];
  let models: Array<{ id: string; isDefault?: boolean }> | "throw" = [
    { id: "default", isDefault: true },
  ];
  let failCreate: ((options: CreateOptions) => Error | null) | null = null;
  let missingActualModel = false;
  let respond: (round: number) => WaitResult = () => ({
    status: "idle",
    lastMessage: "完整验证结论",
  });
  const paseo = {
    providers: {
      listModels: async () => {
        if (models === "throw") throw new Error("catalog down");
        return { models };
      },
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options: CreateOptions) => {
            const failure = failCreate?.(options);
            if (failure) throw failure;
            created.push(options);
            const [provider, model] = options.config.provider.split("/");
            let status = "idle";
            let activeTurn: unknown = null;
            const handle: FakeHandle = {
              id: "tab-" + created.length,
              refresh: async () => {},
              current: () => ({
                provider,
                ...(missingActualModel ? {} : { model }),
                thinkingOptionId: "think",
              }),
              get status() {
                return status;
              },
              get activeTurn() {
                return activeTurn;
              },
              send: async (text, options) => {
                sends.push({ agentId: handle.id, text, ...(options ? { options } : {}) });
                status = "running";
                activeTurn = { id: "turn-" + sends.length };
              },
              waitForFinish: async () => {
                const result = respond(sends.length);
                if (result.status === "permission") {
                  status = "running";
                } else {
                  status = result.status === "idle" ? "idle" : "error";
                  activeTurn = null;
                }
                return result;
              },
              timeline: {
                refetch: async () => ({
                  epoch: "epoch-1",
                  entries: [
                    {
                      item: { type: "assistant_message", messageId: "message-" + sends.length },
                      turnId: "turn-" + sends.length,
                      seqEnd: sends.length,
                    },
                  ],
                }),
              },
            };
            handles.push(handle);
            return handle;
          },
        },
      }),
    },
  };
  return {
    paseo,
    created,
    sends,
    handles,
    setModels: (value: typeof models) => {
      models = value;
    },
    setFailCreate: (fn: typeof failCreate) => {
      failCreate = fn;
    },
    setMissingActualModel: (value: boolean) => {
      missingActualModel = value;
    },
    setRespond: (fn: typeof respond) => {
      respond = fn;
    },
  };
}

function input(extra: Partial<LaunchInput> = {}): LaunchInput {
  return {
    task: { workspaceId: "ws" },
    project: { id: "project" },
    provider: "codex",
    cwd: "/x",
    workspaceId: "ws",
    outputDir: "/o",
    ...extra,
  };
}

describe("验证/复核 tab", () => {
  it("拒绝不是任务原生 workspace 的请求", async () => {
    const f = fakePaseo();
    const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never });
    await expect(launcher.launch(input({ workspaceId: "other" }))).rejects.toThrow(
      "必须使用任务原生 workspace",
    );
    expect(f.created).toHaveLength(0);
  });

  it("按候选顺序跳过创建失败的 provider，全部不可用时明确报错", async () => {
    const f = fakePaseo();
    f.setFailCreate(() => new Error("provider not installed"));
    await expect(
      createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never }).launch(
        input({
          model: undefined,
          snapshot: {
            presetId: "preset",
            source: "task",
            models: [{ provider: "codex", model: "first" }],
            environmentKind: "native",
            instructions: "",
          } as never,
        }),
      ),
    ).rejects.toThrow("预设中的模型均不可用");
    expect(f.created).toHaveLength(0);
    expect(f.sends).toHaveLength(0);
  });

  it("缺失模型时解析 provider 默认模型并记录说明", async () => {
    const f = fakePaseo();
    f.setModels([{ id: "default", isDefault: true }]);
    const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never });
    const explicit = await launcher.launch(input({ model: "explicit" }));
    expect(explicit.note).toBeUndefined();
    expect(f.created[0].config.provider).toBe("codex/explicit");
    const fallback = await launcher.launch(input({ model: undefined }));
    expect(f.created[1].config.provider).toBe("codex/default");
    expect(fallback.note).toContain("默认模型 default");
  });

  it("没有默认模型时拒绝创建 tab", async () => {
    const f = fakePaseo();
    for (const models of [[], "throw"] as const) {
      f.setModels(models);
      await expect(
        createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never }).launch(
          input({ model: undefined }),
        ),
      ).rejects.toThrow("没有默认模型");
    }
    expect(f.created).toHaveLength(0);
  });

  it("实际模型无法核对时保留 tab 并拒绝继续", async () => {
    const f = fakePaseo();
    f.setMissingActualModel(true);
    await expect(
      createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never }).launch(input()),
    ).rejects.toThrow("无法核对验证 tab 的实际模型");
    expect(f.handles).toHaveLength(1);
  });

  it("创建带角色标签和标题的原生 tab，准入后回传选择与源定位", async () => {
    const f = fakePaseo();
    const selections: unknown[] = [];
    const bound: string[] = [];
    let released = 0;
    const agent = await createPaseoVerifierLauncher({
      getPaseo: () => f.paseo as never,
    }).launch(
      input({
        onCreated: (value) => selections.push(value),
        acquire: async () => ({
          bind: async (agentId: string) => {
            bound.push(agentId);
          },
          release: async () => {
            released++;
          },
        }),
        snapshot: {
          presetId: "preset",
          source: "task",
          models: [{ provider: "codex", model: "first" }],
          environmentKind: "native",
          instructions: "中文附加指令",
        } as never,
      }),
    );
    expect(f.created[0].labels).toEqual({ "vibe.tab.role": "verifier", "vibe.tab.preset": "preset" });
    expect(f.created[0].title).toBe("证据验证");
    expect(f.created[0].config.systemPrompt).toContain("中文附加指令");
    expect(f.created[0].env).toMatchObject({ VIBE_ROLE: "verifier", VIBE_WORKSPACE_ID: "ws" });
    expect(bound).toEqual(["tab-1"]);
    expect(selections).toMatchObject([{ agentId: "tab-1", provider: "codex", model: "first" }]);
    expect(await agent.run("核对证据")).toMatchObject({
      status: "idle",
      text: "完整验证结论",
    });
    expect(f.sends).toEqual([
      { agentId: "tab-1", text: "核对证据", options: { sourceAgentId: "tab-1" } },
    ]);
    expect(agent.source).toMatchObject({
      memberId: "tab-1",
      backendAgentId: "tab-1",
      epoch: "epoch-1",
      seq: 1,
      sourceTurnId: "turn-1",
      messageId: "message-1",
    });
    await agent.close();
    expect(released).toBe(1);
  });

  it("复核与验证按角色提示词只读，claude/codex 设 auto，其它 provider 不传模式", async () => {
    const f = fakePaseo();
    const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never });
    await launcher.launch(input({ provider: "claude", role: "reviewer" }));
    await launcher.launch(input({ provider: "codex", role: "reviewer" }));
    await launcher.launch(input({ provider: "gemini", role: "reviewer" }));
    await launcher.launch(input({ provider: "gemini", role: "verifier" }));
    expect(f.created[0].config).toMatchObject({ modeId: "auto" });
    expect(f.created[1].config).toMatchObject({ modeId: "auto" });
    for (const index of [2, 3]) {
      expect(f.created[index].config).not.toHaveProperty("modeId");
      expect(f.created[index].config).not.toHaveProperty("options");
    }
  });

  it("验证角色只对 claude/codex 设置 modeId，其它 provider 保持默认权限", () => {
    const claude = nativeConfig(input({ provider: "claude", role: "verifier" }), "p");
    expect(claude).toMatchObject({ modeId: "auto" });
    const gemini = nativeConfig(input({ provider: "gemini", role: "reviewer" }), "p");
    expect(gemini).not.toHaveProperty("modeId");
    expect(gemini).not.toHaveProperty("options");
  });

  it("提示词来源默认是自身，任务流程指定 anchor 时使用 anchor", async () => {
    const f = fakePaseo();
    const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never });
    const anchored = await launcher.launch(input({ sourceAgentId: "anchor-1" }));
    await anchored.run("任务验证");
    expect(f.sends.at(-1)).toEqual({
      agentId: "tab-1",
      text: "任务验证",
      options: { sourceAgentId: "anchor-1" },
    });
    await anchored.close();
    const own = await launcher.launch(input());
    await own.run("独立验证");
    expect(f.sends.at(-1)?.options).toEqual({ sourceAgentId: own.agentId });
    await own.close();
  });

  it.each(["reviewer", "verifier"] as const)(
    "%s 的提示词和环境限定在本轮确认范围",
    async (role) => {
      const f = fakePaseo();
      const launcher = createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never });
      for (const commitHash of ["commit-before", "commit-current"]) {
        const agent = await launcher.launch(
          input({
            role,
            task: {
              workspaceId: "ws",
              confirmedAt: "2030-01-01T00:00:00.000Z",
              commitHash,
            },
          }),
        );
        await agent.run("当前证据请求");
        await agent.close();
      }
      expect(f.created.map((options) => options.env?.VIBE_VERIFICATION_COMMIT)).toEqual([
        "commit-before",
        "commit-current",
      ]);
      expect(f.created[0].config.systemPrompt).toContain(
        "confirmedAt=2030-01-01T00:00:00.000Z",
      );
      expect(f.created[0].config.systemPrompt).toContain("commit=commit-before");
      expect(f.created[1].config.systemPrompt).toContain("commit=commit-current");
      expect(f.created[1].config.systemPrompt).not.toContain("commit-before");
    },
  );

  it("普通失败不轮换候选模型", async () => {
    const f = fakePaseo();
    f.setRespond(() => ({ status: "error", error: "test assertion failed" }));
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never }).launch(
      input({
        snapshot: {
          presetId: "preset",
          source: "task",
          models: [
            { provider: "codex", model: "first" },
            { provider: "claude", model: "second" },
          ],
          environmentKind: "native",
          instructions: "",
        } as never,
      }),
    );
    expect(await agent.run("复核")).toMatchObject({
      status: "error",
      error: "test assertion failed",
    });
    expect(f.created).toHaveLength(1);
  });

  it("后续轮次登录失败时换新 tab 并带上此前记录", async () => {
    const f = fakePaseo();
    f.setRespond((round) =>
      round === 2
        ? { status: "error", error: "authentication required" }
        : { status: "idle", lastMessage: "此前结论" },
    );
    const replacements: string[] = [];
    let released = 0;
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never }).launch(
      input({
        onReplacement: (next) => replacements.push(next.agentId),
        acquire: async () => ({
          bind: async () => {},
          release: async () => {
            released++;
          },
        }),
        snapshot: {
          presetId: "preset",
          source: "task",
          models: [
            { provider: "codex", model: "first" },
            { provider: "codex", model: "second" },
          ],
          environmentKind: "native",
          instructions: "",
        } as never,
      }),
    );
    await agent.run("准备证据");
    expect(await agent.run("判断证据")).toMatchObject({ status: "idle" });
    expect(f.created.map((options) => options.config.provider)).toEqual([
      "codex/first",
      "codex/second",
    ]);
    expect(f.sends[2].agentId).toBe("tab-2");
    expect(f.sends[2].text).toContain("准备证据");
    expect(f.sends[2].text).toContain("此前结论");
    expect(f.sends[2].text).toContain("判断证据");
    expect(replacements).toEqual(["tab-2"]);
    expect(released).toBe(1);
  });

  it("候选索引作为起点", async () => {
    const f = fakePaseo();
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo as never }).launch(
      input({
        candidateIndex: 1,
        snapshot: {
          presetId: "preset",
          source: "task",
          models: [
            { provider: "codex", model: "first" },
            { provider: "codex", model: "second" },
          ],
          environmentKind: "native",
          instructions: "",
        } as never,
      }),
    );
    expect(f.created[0].config.provider).toBe("codex/second");
    await agent.run("重验");
    expect(f.sends).toHaveLength(1);
  });

  it("tab 仍在运行时拒绝释放租约", async () => {
    const f = fakePaseo();
    let released = 0;
    const agent = await createPaseoVerifierLauncher({
      getPaseo: () => f.paseo as never,
      roundTimeoutMs: 20,
      pollMs: 1,
    }).launch(
      input({
        acquire: async () => ({
          bind: async () => {},
          release: async () => {
            released++;
          },
        }),
      }),
    );
    f.setRespond(() => ({ status: "permission", lastMessage: "等待授权" }));
    expect(await agent.run("等待授权")).toMatchObject({ status: "timeout" });
    await expect(agent.close()).rejects.toThrow("尚未停止");
    expect(released).toBe(0);
  });
});
