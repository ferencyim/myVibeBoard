import { describe, expect, it } from "vitest";
import { createSubAgentRunner } from "../server/launch";
import type { MaintenanceRule, Preset, Project } from "../server/vibe/contract";

const preset = {
  id: "maintenance", name: "维护", provider: "codex", model: "first", thinking: "", permissionMode: "auto",
  models: [
    { provider: "codex", model: "first", thinking: "", permissionMode: "auto" },
    { provider: "claude", model: "second", thinking: "", permissionMode: "auto" },
  ],
} as Preset;
const rule = { name: "检查", agent: "maintenance" } as MaintenanceRule;
const project = { repoPath: "/repo", defaultPresets: {} } as Project;

function runner(error: string, secondFails = false) {
  const attempted: Array<{ provider: string; modeId: string }> = [];
  const archived: string[] = [];
  const prompts: string[] = [];
  const paseo = { agents: { create: async ({ config }: { config: { provider: string; modeId: string } }) => {
    attempted.push(config);
    return {
      run: async (prompt: string) => {
        prompts.push(prompt);
        return config.provider === "codex/first" || secondFails
          ? { status: "error", error }
          : { status: "idle", lastMessage: "维护计划" };
      },
      archive: async () => { archived.push(config.provider); },
    };
  } } };
  return {
    attempted, archived, prompts,
    run: createSubAgentRunner({ getPaseo: () => paseo as never, presets: () => [preset], defaultAgent: () => "codex/first" }),
  };
}

describe("maintenance preset fallback", () => {
  it("uses the next model after a provider failure and keeps the check prompt read-only", async () => {
    const r = runner("authentication required");
    expect(await r.run.run({ rule, project, prompt: "分析此处的检查结果" })).toBe("维护计划");
    expect(r.attempted).toEqual([
      { provider: "codex/first", modeId: "read-only" },
      { provider: "claude/second", modeId: "plan" },
    ]);
    expect(r.archived).toEqual(["codex/first", "claude/second"]);
    expect(r.prompts).toEqual(["分析此处的检查结果", "分析此处的检查结果"]);
  });

  it("keeps ordinary task failures on the selected model", async () => {
    const r = runner("test assertion failed");
    await expect(r.run.run({ rule, project, prompt: "检查" })).rejects.toThrow("test assertion failed");
    expect(r.attempted).toHaveLength(1);
    expect(r.archived).toEqual(["codex/first"]);
  });

  it("fails clearly after exhausting all models", async () => {
    const r = runner("quota exceeded", true);
    await expect(r.run.run({ rule, project, prompt: "检查" })).rejects.toThrow("维护预设中的模型均不可用");
    expect(r.attempted.map((a) => a.provider)).toEqual(["codex/first", "claude/second"]);
    expect(r.archived).toEqual(["codex/first", "claude/second"]);
  });
});
