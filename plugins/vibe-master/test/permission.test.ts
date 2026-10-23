import { describe, expect, it } from "vitest";
import { createMasterRuntime } from "../server/runtime";
import { createPermissionResolver, isBoardMcpCall } from "../server/subscription/permission";
import {
  askMaster,
  ManualClock,
  MODES,
  defaultSettings,
  fakePaseo,
  setupBoard,
  tempDir,
} from "./helpers";

function build(over: { mode?: string; provider?: string; modes?: typeof MODES } = {}) {
  const board = setupBoard();
  const fake = fakePaseo(() => "ok", { modes: over.modes });
  const settings = defaultSettings({
    provider: over.provider ?? "claude",
    permissionMode: over.mode ?? "auto",
  });
  const runtime = createMasterRuntime({
    admitMaster: async () => async () => undefined,
    admitMemory: async () => async () => undefined,
    db: board.db,
    store: board.store,
    getPaseo: () => fake.paseo,
    settings: () => settings,
    dataDir: tempDir(),
    clock: new ManualClock(),
    pollIntervalMs: 3_600_000,
    log: () => undefined,
  });
  return { board, fake, runtime, settings };
}

describe("permission mode mapping", () => {
  const resolve = (provider: string, requested: string, modes = MODES) => {
    const fake = fakePaseo(() => "", { modes });
    return createPermissionResolver(() => fake.paseo).resolve(provider, requested);
  };

  it("maps auto to each provider's automatic mode and falls back below Full Access", async () => {
    expect(await resolve("claude", "auto")).toMatchObject({
      modeId: "auto",
      auto: true,
      label: "Auto mode",
    });
    expect(await resolve("codex", "auto")).toMatchObject({ modeId: "auto-review", auto: true });
    const oldCodex = { ...MODES, codex: MODES.codex!.filter((m) => m.id !== "auto-review") };
    expect(await resolve("codex", "auto", oldCodex)).toMatchObject({
      modeId: "auto",
      label: "Default Permissions",
    });
    // a provider without any automatic mode keeps its own default instead of a guess
    expect(await resolve("kimi", "auto", { kimi: [{ id: "yolo", label: "YOLO" }] })).toMatchObject({
      modeId: null,
    });
  });

  it("uses an explicit mode when the provider offers it, else the automatic one", async () => {
    expect(await resolve("claude", "acceptEdits")).toMatchObject({
      modeId: "acceptEdits",
      auto: false,
    });
    expect(await resolve("codex", "acceptEdits")).toMatchObject({
      modeId: "auto-review",
      auto: true,
    });
    const options = (await resolve("codex", "auto")).options.map((o) => o.id);
    expect(options).toEqual(["auto-review", "full-access"]); // "auto" is the special entry, not a raw codex mode
  });
});

describe("master permission mode", () => {
  it("starts the master and the planners in auto mode by default", async () => {
    const t = build();
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    expect(t.fake.agents[0]!.options.config.modeId).toBe("auto");
    const status = await t.runtime.status();
    expect(status.permission).toMatchObject({
      setting: "auto",
      source: "settings",
      modeId: "auto",
      auto: true,
    });
    await t.runtime.dispose();
  });

  it("uses the Codex auto-review mode for a Codex master", async () => {
    const t = build({ provider: "codex" });
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    expect(t.fake.agents[0]!.options.config.modeId).toBe("auto-review");
    await t.runtime.dispose();
  });

  it("applies a settings change to the next ask by replacing the agent", async () => {
    const t = build();
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    t.settings.permissionMode = "acceptEdits";
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    expect(t.fake.agents.map((a) => a.options.config.modeId)).toEqual(["auto", "acceptEdits"]);
    expect(t.fake.agents[0]!.archived).toBe(false); // WP-93: the old conversation stays openable
    expect(t.board.store.sessions.list({ role: "master" }).map((s) => s.state)).toEqual([
      "ended",
      "idle",
    ]);
    await t.runtime.dispose();
  });

  it("switches a running master at once, keeps the batch going and can return to the settings", async () => {
    const t = build();
    await askMaster(t.runtime);
    await t.runtime.queue.idle();

    const switched = await t.runtime.setPermission("bypassPermissions");
    expect(switched.changed).toBe(true);
    expect(t.fake.agents.map((a) => a.options.config.modeId)).toEqual([
      "auto",
      "bypassPermissions",
    ]);
    expect(t.fake.agents[0]!.archived).toBe(false); // WP-93: the old conversation stays openable
    expect((await t.runtime.status()).permission).toMatchObject({
      setting: "bypassPermissions",
      source: "switched",
      modeId: "bypassPermissions",
    });

    expect((await t.runtime.setPermission("bypassPermissions")).changed).toBe(false);
    expect(t.fake.agents).toHaveLength(2);

    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    expect(t.fake.agents[1]!.prompts).toHaveLength(1); // the new agent carries on

    expect((await t.runtime.setPermission("settings")).changed).toBe(true);
    expect(t.fake.agents[2]!.options.config.modeId).toBe("auto");
    await t.runtime.dispose();
  });

  it("only remembers the choice when no master is running yet", async () => {
    const t = build();
    expect(await t.runtime.setPermission("default")).toEqual({ changed: false, sessionId: null });
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    expect(t.fake.agents[0]!.options.config.modeId).toBe("default");
    await t.runtime.dispose();
  });
});

describe("permission requests of the master", () => {
  const board = (name: string, metadata?: unknown) => ({ id: "r1", kind: "tool", name, metadata });

  it("recognises only vibe-board MCP tool calls", () => {
    expect(isBoardMcpCall(board("mcp__vibe-board__vibe_card_comment"))).toBe(true);
    expect(isBoardMcpCall(board("CodexMcpElicitation", { serverName: "vibe-board" }))).toBe(true);
    expect(isBoardMcpCall(board("CodexMcpElicitation", { serverName: "other" }))).toBe(false);
    expect(isBoardMcpCall(board("mcp__other__vibe_card_comment"))).toBe(false);
    expect(isBoardMcpCall(board("Bash"))).toBe(false);
    expect(isBoardMcpCall({ id: "r", kind: "question", name: "mcp__vibe-board__x" })).toBe(false);
  });

  it("does not auto-approve legacy board writes from the task master and ignores other agents", async () => {
    const t = build();
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    const masterId = t.fake.agents[0]!.id;
    const approved: string[] = [];
    const approve = async (id: string) => void approved.push(id);

    expect(
      await t.runtime.onPermissionRequest(
        masterId,
        board("mcp__vibe-board__vibe_card_comment"),
        approve,
      ),
    ).toBe("alerted");
    expect(approved).toEqual([]);

    expect(await t.runtime.onPermissionRequest(masterId, board("Bash"), approve)).toBe("alerted");
    expect(approved).toEqual([]);
    const alerts = t.board.db
      .prepare<{ payload_json: string }>(
        "SELECT payload_json FROM vibe_event WHERE type = 'master.alert'",
      )
      .all()
      .map((r) => JSON.parse(r.payload_json) as { kind: string });
    expect(alerts.map((a) => a.kind)).toEqual(["permission_wait"]);

    expect(
      await t.runtime.onPermissionRequest("someone-else", board("mcp__vibe-board__x"), approve),
    ).toBe("ignored");
    expect(approved).toEqual([]);
    await t.runtime.dispose();
  });
});
