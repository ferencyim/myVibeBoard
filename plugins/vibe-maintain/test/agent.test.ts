import { describe, expect, it } from "vitest";
import { modeFor, resolveAgent } from "../server/agent";
import type { MaintenanceRule, Preset, Project } from "../server/vibe/contract";

const preset = (over: Partial<Preset>): Preset =>
  ({
    id: "p1",
    name: "Codex Fast",
    provider: "codex",
    model: "gpt-6-mini",
    thinking: "",
    permissionMode: "auto",
    environmentKind: "project-default",
    baseBranch: null,
    runtimeEnv: null,
    instructions: "",
    builtin: false,
    ...over,
  }) as Preset;
const project = { id: "pr", defaultPresetId: null } as Project;
const rule = (agent: string | null) => ({ name: "r", agent }) as MaintenanceRule;
const deps = (presets: Preset[], defaultAgent = "claude/sonnet") => ({ presets: () => presets, defaultAgent: () => defaultAgent });

describe("maintenance fix agent resolution", () => {
  it("maps a preset name to its model and permission mode", () => {
    const r = resolveAgent(rule("codex fast"), project, deps([preset({})]));
    expect(r).toMatchObject({ provider: "codex", spec: "codex/gpt-6-mini", modeId: "auto" });
  });

  it("uses the unattended accept-edits mode for provider/model without a preset", () => {
    expect(resolveAgent(rule("codex/gpt-6"), project, deps([])).modeId).toBe("auto-review");
    expect(resolveAgent(rule("claude/sonnet"), project, deps([])).modeId).toBe("acceptEdits");
  });

  it("borrows the model of a preset for a bare provider, or fails clearly", () => {
    expect(resolveAgent(rule("codex"), project, deps([preset({})])).spec).toBe("codex/gpt-6-mini");
    expect(() => resolveAgent(rule("codex"), project, deps([]))).toThrow(/codex\/<model>/);
  });

  it("lets selectAgent choose among presets when the rule names none", () => {
    const cheap = preset({ id: "cheap", name: "Cheap", provider: "claude", model: "haiku", permissionMode: "accept-edits" });
    const strong = preset({ id: "strong", name: "Strong", provider: "claude", model: "opus", permissionMode: "full" });
    const r = resolveAgent(rule(null), project, deps([strong, cheap]));
    expect(r.spec).toBe("claude/haiku");
    expect(r.modeId).toBe("acceptEdits");
  });

  it("falls back to the settings default agent without presets, never full access", () => {
    const r = resolveAgent(rule(null), project, deps([]));
    expect(r).toMatchObject({ spec: "claude/sonnet", modeId: "acceptEdits" });
    expect(modeFor("codex", null)).toBe("auto-review");
  });
});
