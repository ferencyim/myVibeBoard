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
        return { run: async () => ({ status: "idle", lastMessage: "" }), archive: async () => {} };
      },
    },
    workspaces: { ref: () => ({ agents: { create: async (o: any) => (created.push(o), { run: async () => ({ status: "idle" }), archive: async () => {} }) } }) },
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
  it("uses the preset model as is", async () => {
    const f = fakePaseo([]);
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(input({ model: "gpt-5" }));
    expect(f.created[0].config.provider).toBe("codex/gpt-5");
    expect(agent.note).toBeUndefined();
  });

  it("fills a missing model with the provider default and reports it", async () => {
    const f = fakePaseo([{ id: "a" }, { id: "gpt-5-codex", isDefault: true }]);
    const agent = await createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(input({ role: "reviewer" }));
    expect(f.created[0].config.provider).toBe("codex/gpt-5-codex");
    expect(agent.note).toContain("gpt-5-codex");
  });

  it("refuses with a clear message when there is no default model", async () => {
    for (const models of [[], "throw"] as const) {
      const f = fakePaseo(models);
      await expect(createPaseoVerifierLauncher({ getPaseo: () => f.paseo }).launch(input())).rejects.toThrow(/no model/);
      expect(f.created).toHaveLength(0);
    }
  });
});
