/* oxlint-disable typescript-eslint/no-explicit-any -- reads untyped RPC answers */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as contract from "../../../../../plugins/vibe-board/shared/rpc";
import { createSyncEngine } from "../sync/engine";
import { createFakeDaemon, seedBoard } from "../sync/test-daemon";
import { LocalReplica } from "../store/replica";
import { createTestDb } from "../store/test-db";
import { OfflineRpcError, createLocalVibeRpc } from "./local-rpc";

type Rpc = ReturnType<typeof createLocalVibeRpc>;

const contracts = Object.values(contract.VIBE_BOARD_RPCS);

/** Calls through the plugin's own contract: input and output are parsed like the plugin UI does. */
async function call(rpc: Rpc, name: string, input: unknown = {}): Promise<any> {
  const definition = contracts.find((c) => c.name === name);
  if (!definition) throw new Error(`no contract for ${name}`);
  const parsed = await definition.input.parseAsync(input);
  return definition.output.parseAsync(await rpc.invoke(name, parsed));
}

async function seeded() {
  const daemon = createFakeDaemon();
  seedBoard(daemon);
  const replica = LocalReplica.open(createTestDb());
  await createSyncEngine({ replica, invoke: (m, i) => daemon.invoke(m, i) }).run();
  return { daemon, replica, rpc: createLocalVibeRpc(replica) };
}

describe("local vibe-board RPC", () => {
  let rpc: Rpc;
  let replica: LocalReplica;
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    ({ rpc, replica } = await seeded());
  });

  it("answers every offline method with the plugin contract's shape", async () => {
    expect((await call(rpc, "vibe.projects.list")).projects.map((p: any) => p.prefix)).toEqual([
      "ALP",
    ]);
    const summary = await call(rpc, "vibe.board.summary");
    expect(summary.totals).toEqual({ draft: 1, todo: 1, in_progress: 1, verifying: 0, done: 1 });
    expect(summary.projects[0].counts.todo).toBe(1);
    expect((await call(rpc, "vibe.tags.list")).tags.map((t: any) => t.name)).toEqual(["bug", "ui"]);
    expect((await call(rpc, "vibe.presets.list")).presets[0]).toMatchObject({
      name: "Default",
      builtin: true,
    });
    const detail = await call(rpc, "vibe.cards.get", { card: "ALP-1" });
    expect(detail.card.tags).toEqual(["T1", "T2"]);
    expect(detail.events.map((e: any) => e.body)).toEqual([{ text: "hello" }]);
    expect((await call(rpc, "vibe.cards.get", { card: "ALP-3" })).sessions[0]).toMatchObject({
      agentId: "agent-1",
      state: "working",
    });
    expect((await call(rpc, "vibe.events.list", { card: "ALP-1" })).events).toHaveLength(1);
    expect((await call(rpc, "vibe.plans.list", { card: "ALP-1" })).versions).toEqual([]);
    expect((await call(rpc, "vibe.sessions.list", {})).sessions).toHaveLength(1);
    expect((await call(rpc, "vibe.attachments.list", { card: "ALP-1" })).attachments).toEqual([]);
  });

  it("keeps the ordered model candidates when reading synced presets offline", async () => {
    const daemon = createFakeDaemon();
    seedBoard(daemon);
    const models = [
      { provider: "claude", model: "sonnet", thinking: "high", permissionMode: "auto" },
      { provider: "codex", model: "gpt-5.4", thinking: "medium", permissionMode: "accept-edits" },
    ];
    daemon.publish("preset", "PR1", { models_json: JSON.stringify(models) });
    const local = LocalReplica.open(createTestDb());
    await createSyncEngine({
      replica: local,
      invoke: (method, input) => daemon.invoke(method, input),
    }).run();
    expect((await call(createLocalVibeRpc(local), "vibe.presets.list")).presets[0].models).toEqual(
      models,
    );
  });

  it("filters, orders and truncates the card list", async () => {
    expect(
      (await call(rpc, "vibe.cards.list", { column: "todo" })).cards.map((c: any) => c.key),
    ).toEqual(["ALP-2"]);
    expect((await call(rpc, "vibe.cards.list", { search: "shipped" })).cards).toHaveLength(1);
    expect(
      (await call(rpc, "vibe.cards.list", { tagId: "T1" })).cards.map((c: any) => c.id),
    ).toEqual(["C1"]);
    const limited = await call(rpc, "vibe.cards.list", { limit: 2 });
    expect(limited.cards).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it("creates cards at the end of the column, with tags, as a pending sync change", async () => {
    const { card } = await call(rpc, "vibe.cards.create", {
      project: "ALP",
      title: "Offline card",
      description: "from the plane",
      priority: "high",
      tagIds: ["T2"],
    });
    expect(card).toMatchObject({
      title: "Offline card",
      column: "draft",
      tags: ["T2"],
      priority: "high",
    });
    expect(card.key).toMatch(/^ALP-/);
    const draft = (await call(rpc, "vibe.cards.list", { column: "draft" })).cards;
    expect(draft.map((c: any) => c.title)).toEqual(["First idea", "Offline card"]);
    expect(replica.hasPending).toBe(true);
    // The provisional key still opens the card after the daemon numbers it.
    expect((await call(rpc, "vibe.cards.get", { card: card.key })).card.id).toBe(card.id);
    await expect(call(rpc, "vibe.cards.create", { project: "NOPE", title: "x" })).rejects.toThrow(
      "[not_found]",
    );
  });

  it("moves cards between draft and todo only", async () => {
    const moved = await call(rpc, "vibe.cards.move", { card: "ALP-1", to: "todo", actor: "phone" });
    expect(moved.card.column).toBe("todo");
    // lands behind the existing todo card
    const todo = (await call(rpc, "vibe.cards.list", { column: "todo" })).cards;
    expect(todo.map((c: any) => c.key)).toEqual(["ALP-2", "ALP-1"]);
    await expect(
      call(rpc, "vibe.cards.move", { card: "ALP-2", to: "in_progress" }),
    ).rejects.toThrow("[actor_not_allowed]");
    await expect(call(rpc, "vibe.cards.move", { card: "ALP-3", to: "draft" })).rejects.toThrow(
      "[illegal_transition]",
    );
    await expect(call(rpc, "vibe.cards.move", { card: "ALP-2", to: "todo" })).rejects.toThrow(
      "[same_column]",
    );
  });

  it("reorders within a column using neighbours", async () => {
    await call(rpc, "vibe.cards.move", { card: "ALP-1", to: "todo" });
    await call(rpc, "vibe.cards.reorder", { card: "ALP-1", beforeCard: "ALP-2" });
    const todo = (await call(rpc, "vibe.cards.list", { column: "todo" })).cards;
    expect(todo.map((c: any) => c.key)).toEqual(["ALP-1", "ALP-2"]);
    await expect(
      call(rpc, "vibe.cards.reorder", { card: "ALP-3", beforeCard: "ALP-1" }),
    ).rejects.toThrow("[actor_not_allowed]");
  });

  it("updates fields and tags, archives and deletes drafts", async () => {
    const { card } = await call(rpc, "vibe.cards.update", {
      card: "C1",
      title: "Edited",
      needsEvidence: true,
      tagIds: ["T2"],
    });
    expect(card).toMatchObject({ title: "Edited", needsEvidence: true, tags: ["T2"] });
    await call(rpc, "vibe.cards.archive", { card: "ALP-2" });
    expect((await call(rpc, "vibe.board.summary")).totals.todo).toBe(0);
    expect((await call(rpc, "vibe.cards.list", { includeArchived: true })).cards).toHaveLength(4);
    expect((await call(rpc, "vibe.cards.delete", { card: "ALP-1" })).deleted).toBe(true);
    await expect(call(rpc, "vibe.cards.get", { card: "ALP-1" })).rejects.toThrow("[not_found]");
    await expect(call(rpc, "vibe.cards.delete", { card: "ALP-4" })).rejects.toThrow("[invalid]");
  });

  it("offline: picks the plan / execution models and marks tabs read (WP-105)", async () => {
    const { card } = await call(rpc, "vibe.cards.update", {
      card: "ALP-1",
      plannerPresetId: "P1",
      scoutPresetId: null,
      planSeenAt: "2026-10-21T10:00:00.000Z",
    });
    expect(card).toMatchObject({
      plannerPresetId: "P1",
      scoutPresetId: null,
      planSeenAt: "2026-10-21T10:00:00.000Z",
      plan: null,
      modelAcceptance: "",
    });
    const { event } = await call(rpc, "vibe.chat.send", {
      card: "ALP-1",
      text: "go on",
      thread: "exec",
    });
    expect(event.body).toEqual({ text: "go on", thread: "exec" });
  });

  it("adds notes only", async () => {
    const { event } = await call(rpc, "vibe.events.add", { card: "ALP-1", text: "offline note" });
    expect(event).toMatchObject({
      type: "note",
      authorKind: "user",
      body: { text: "offline note" },
    });
    expect((await call(rpc, "vibe.events.list", { card: "ALP-1" })).events).toHaveLength(2);
    await expect(
      call(rpc, "vibe.events.add", { card: "ALP-1", type: "status", text: "x" }),
    ).rejects.toThrow("[actor_not_allowed]");
  });

  it("sends group chat messages as user chat events and still refuses proposals offline", async () => {
    const { event } = await call(rpc, "vibe.chat.send", {
      card: "ALP-1",
      text: "hi",
      actor: "phone",
    });
    expect(event).toMatchObject({
      type: "chat",
      authorKind: "user",
      author: "phone",
      body: { text: "hi", thread: "plan" },
    });
    const events = (await call(rpc, "vibe.events.list", { card: "ALP-1" })).events;
    expect(events.filter((e: any) => e.type === "chat")).toHaveLength(1);
    await expect(rpc.invoke("vibe.proposals.accept", { eventId: event.id })).rejects.toBeInstanceOf(
      OfflineRpcError,
    );
  });

  it("refuses what needs the computer with an offline error", async () => {
    for (const method of [
      "vibe.cards.dispatch",
      "vibe.providers.catalog",
      "vibe.projects.create",
      "vibe.tags.create",
    ]) {
      await expect(rpc.invoke(method, {})).rejects.toBeInstanceOf(OfflineRpcError);
    }
    await expect(rpc.invoke("vibe.cards.dispatch", {})).rejects.toThrow("[offline]");
  });
});
