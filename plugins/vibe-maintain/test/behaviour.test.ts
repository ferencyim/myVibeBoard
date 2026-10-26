// WP-99: the former hard-coded automation parameters are settings with unchanged defaults.

import { describe, expect, it, vi } from "vitest";
import { maintainSettings } from "../shared/rpc";

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
    });
  });
});

it("冷启动等待界面规则读取，不能用空配置禁用已有规则或清除计数", async () => {
  const dbModule = await import("../server/vibe/db");
  const { setup, tempDir } = await import("./helpers");
  const { statusRpc } = await import("../shared/rpc");
  const h = setup({ repo: tempDir() });
  const commands = dbModule.createMaintenanceCommands(h.db);
  const ruleId = h.project.id + ":custom";
  commands.upsertRule({
    id: ruleId,
    projectId: h.project.id,
    name: "custom",
    enabled: true,
    triggerKind: "workload",
    trigger: { kind: "workload", cards_done: 100 },
    check: { type: "git" },
    agent: null,
    outputMode: "suggest",
    priority: "low",
    dedupeKey: null,
    dailyCap: 1,
  });
  commands.setCounter(h.project.id, ruleId + ":cards", 7);
  let resolveRules!: (value: unknown) => void;
  const loaded = new Promise((resolve) => {
    resolveRules = resolve;
  });
  type Handler = (input: unknown, context: { paseo: unknown }) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const open = vi.spyOn(dbModule, "openVibeDb").mockReturnValue(h.db);
  const contribute = (await import("../index.server")).default;
  const server = {
    registerSettings: (definition: { id: string }) => ({
      read: () =>
        definition.id === "rules"
          ? loaded
          : Promise.resolve({ status: "ready", values: maintainSettings.schema.parse({}) }),
      subscribe: () => () => {},
    }),
    handle: (rpc: { name: string }, handler: Handler) => {
      handlers.set(rpc.name, handler);
    },
    on: () => () => {},
  };
  const close = contribute(server as unknown as Parameters<typeof contribute>[0]);
  let settled = false;
  try {
    const status = handlers.get(statusRpc.name)!({}, { paseo: {} }).then(() => {
      settled = true;
      return null;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(h.engine.listRules().find((r) => r.id === ruleId)?.enabled).toBe(true);
    resolveRules({
      status: "ready",
      values: {
        rules: {
          custom: {
            trigger: { kind: "workload", cards_done: 100 },
            check: { type: "git" },
            projects: "all",
          },
        },
      },
    });
    await status;
    expect(h.engine.listRules().find((r) => r.id === ruleId)?.enabled).toBe(true);
    expect(commands.counter(h.project.id, ruleId + ":cards")?.count).toBe(7);
  } finally {
    await close();
    open.mockRestore();
  }
});
