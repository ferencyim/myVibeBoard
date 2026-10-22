// WP-99: the former hard-coded automation parameters are settings with unchanged defaults.

import { describe, expect, it } from "vitest";
import { UNATTENDED_MODE, resolveAgent } from "../server/agent";
import { READ_ONLY_MODE, createSubAgentRunner } from "../server/launch";
import type { MaintenanceRule, Project } from "../server/vibe/contract";
import { maintainSettings } from "../shared/rpc";

const project = { id: "pr", defaultPresets: {}, repoPath: "/repo" } as Project;
const rule = (agent: string | null) => ({ name: "r", id: "r1", agent }) as MaintenanceRule;

describe("maintenance settings", () => {
  it("default settings equal the old constants", () => {
    const s = maintainSettings.schema.parse({});
    expect(s).toMatchObject({
      enabled: true,
      tickSeconds: 30,
      pauseAfterRejections: 3,
      defaultAgent: "claude/sonnet",
      subAgentTimeoutMinutes: 10,
      commitPollSeconds: 60,
      unattendedModes: { claude: "acceptEdits", codex: "auto-review" },
      readOnlyModes: { claude: "plan", codex: "read-only" },
    });
    expect(s.unattendedModes).toEqual(UNATTENDED_MODE);
    expect(s.readOnlyModes).toEqual(READ_ONLY_MODE);
  });

  it("the unattended mode mapping comes from the setting", () => {
    const deps = { presets: () => [], defaultAgent: () => "claude/sonnet", unattendedModes: () => ({ claude: "auto", kimi: "yolo" }) };
    expect(resolveAgent(rule("claude/sonnet"), project, deps).modeId).toBe("auto");
    expect(resolveAgent(rule("kimi/k2"), project, deps).modeId).toBe("yolo");
    expect(resolveAgent(rule("codex/gpt-6"), project, deps).modeId).toBeUndefined(); // not listed: provider default
  });

  it("a sub agent run uses the configured timeout and read-only mode, read at run time", async () => {
    const seen: { modeId?: string; timeoutMs?: number }[] = [];
    let minutes = 10;
    let modes: Record<string, string> = { claude: "plan" };
    const paseo = {
      agents: {
        create: async (options: { config: { modeId?: string } }) => ({
          run: async (_prompt: string, o: { timeoutMs: number }) => {
            seen.push({ modeId: options.config.modeId, timeoutMs: o.timeoutMs });
            return { status: "idle", lastMessage: "ok" };
          },
          archive: async () => {},
        }),
      },
    } as never;
    const runner = createSubAgentRunner({
      presets: () => [],
      defaultAgent: () => "claude/sonnet",
      getPaseo: () => paseo,
      timeoutMs: () => minutes * 60_000,
      readOnlyModes: () => modes,
    });
    const input = { rule: rule("claude/sonnet"), project, prompt: "go" } as never;
    await runner.run(input);
    minutes = 3;
    modes = { claude: "read-only-x" };
    await runner.run(input);
    expect(seen).toEqual([
      { modeId: "plan", timeoutMs: 600_000 },
      { modeId: "read-only-x", timeoutMs: 180_000 },
    ]);
  });
});
