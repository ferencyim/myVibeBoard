import type { PaseoWorkspaceAgentCreateOptions } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
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

describe("原生任务只读辅助会话", () => {
  it("冻结候选按序接续，先绑定/核对实际模型再运行，停止确认后才释放", async () => {
    const f = fakePaseo([]);
    const events: string[] = [];
    const selections: unknown[] = [];
    let activeTurn: unknown = null;
    f.paseo.workspaces.ref = () => ({
      agents: {
        create: async (options: PaseoWorkspaceAgentCreateOptions) => {
          f.created.push(options);
          const [provider, model] = options.config.provider.split("/");
          return {
            current: () => ({ provider, model: "actual-" + model }),
            refresh: async () => {},
            get status() {
              return "idle";
            },
            get activeTurn() {
              return activeTurn;
            },
            run: async () => {
              events.push("run:" + model);
              return model === "first"
                ? { status: "error", error: "authentication required" }
                : { status: "idle", lastMessage: "结论" };
            },
          };
        },
      },
    });
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      input({
        card: undefined,
        task: { workspaceId: "ws", anchorAgentId: "anchor" },
        workspaceId: "ws",
        model: "first",
        snapshot: {
          models: [
            { provider: "codex", model: "first", thinking: "", permissionMode: "auto" },
            { provider: "claude", model: "second", thinking: "", permissionMode: "auto" },
          ],
          runtimeEnv: "node",
          instructions: "中文附加指令",
        },
        acquire: async (provider: string, index: number) => {
          events.push("acquire:" + index);
          return {
            bind: async () => {
              events.push("bind:" + provider);
            },
            release: async () => {
              events.push("release:" + provider);
            },
          };
        },
        onCreated: (value: unknown) => {
          selections.push(value);
          events.push("registered");
        },
      }),
    );
    expect(f.created[0]).toMatchObject({
      parent: "anchor",
      labels: { workspaceId: "ws", role: "verifier" },
      env: { VIBE_WORKSPACE_ID: "ws" },
      config: { options: { sandbox_mode: "read-only", approval_policy: "never" } },
    });
    expect(f.created[0].env.VIBE_CARD_ID).toBeUndefined();
    expect(f.created[0].config.systemPrompt).toContain("中文附加指令");
    expect(await agent.run("核对证据")).toMatchObject({ status: "idle" });
    expect(events).toEqual([
      "acquire:0",
      "bind:codex",
      "registered",
      "run:first",
      "release:codex",
      "acquire:1",
      "bind:claude",
      "registered",
      "run:second",
    ]);
    expect(selections).toMatchObject([
      { provider: "codex", model: "actual-first", candidateIndex: 0 },
      { provider: "claude", model: "actual-second", candidateIndex: 1 },
    ]);
    activeTurn = { id: "still-running" };
    await expect(agent.close()).rejects.toThrow("尚未停止");
    expect(events).not.toContain("release:claude");
    activeTurn = null;
    await agent.close();
    expect(events.at(-1)).toBe("release:claude");
  });
  it("普通命令ENOENT或进程退出不能轮换任务验证模型", async () => {
    const f = fakePaseo([]);
    let created = 0;
    f.paseo.workspaces.ref = () => ({
      agents: {
        create: async () => {
          created++;
          return {
            current: () => ({ provider: "codex", model: "first" }),
            refresh: async () => {},
            status: "idle",
            activeTurn: null,
            run: async () => ({
              status: "error",
              error: "test process exited with code 1 (ENOENT fixture)",
            }),
          };
        },
      },
    });
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(
      input({
        card: undefined,
        task: { workspaceId: "ws", anchorAgentId: "anchor" },
        workspaceId: "ws",
        model: "first",
        snapshot: {
          models: [
            { provider: "codex", model: "first" },
            { provider: "claude", model: "second" },
          ],
        },
      }),
    );
    expect(await agent.run("测试")).toMatchObject({ status: "error" });
    expect(created).toBe(1);
    await agent.close();
  });
});
