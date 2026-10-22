import { describe, expect, it } from "vitest";
import { createMasterRuntime } from "../server/runtime";
import { askMaster, choosePreset, ManualClock, defaultSettings, fakePaseo, setupBoard, tempDir } from "./helpers";

function build(over: { noSetTitle?: boolean } = {}) {
  const board = setupBoard();
  const fake = fakePaseo(() => "ok", { noSetTitle: over.noSetTitle });
  const settings = defaultSettings({ provider: "claude" });
  const runtime = createMasterRuntime({
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

const RETIRED = /^Vibe Master（已退役 \d{4}-\d{2}-\d{2}）$/;

async function started(t: ReturnType<typeof build>) {
  await askMaster(t.runtime);
  await t.runtime.queue.idle();
}

describe("retired master agents are renamed", () => {
  it("renames the old agent on a preset switch", async () => {
    const t = build();
    await started(t);
    await choosePreset(t, t.board.presets.codex.id);
    expect(t.fake.agents[0]!.title).toMatch(RETIRED);
    expect(t.fake.agents[1]!.title).toBeUndefined();
    await t.runtime.dispose();
  });

  it("renames the old agent on a permission mode change", async () => {
    const t = build();
    await started(t);
    await t.runtime.setPermission("acceptEdits");
    expect(t.fake.agents[0]!.title).toMatch(RETIRED);
    await t.runtime.dispose();
  });

  it("renames the old agent when it is rebuilt after a settings change", async () => {
    const t = build();
    await started(t);
    t.settings.permissionMode = "acceptEdits";
    await askMaster(t.runtime);
    await t.runtime.queue.idle();
    expect(t.fake.agents[0]!.title).toMatch(RETIRED);
    await t.runtime.dispose();
  });

  it("skips the rename on a host without setTitle", async () => {
    const t = build({ noSetTitle: true });
    await started(t);
    await t.runtime.setPermission("acceptEdits");
    expect(t.fake.agents).toHaveLength(2);
    expect(t.fake.agents[0]!.title).toBeUndefined();
    expect(t.runtime.sessions()[1]).toMatchObject({ retiredReason: "mode_changed" });
    await t.runtime.dispose();
  });
});
