import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runBoardCli } from "../server/cli/runner";
import { startBoardBridge } from "../server/mcp/bridge";
import { callMcpTool, MCP_TOOLS, toolsForRole } from "../server/mcp/tools";
import { registerBoardRpcs } from "../server/rpc";
import { agentActor, BoardError } from "../server/service";
import * as rpc from "../shared/rpc";
import { eventTypes, setupBoard, tempDir } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

function withProject() {
  const ctx = setupBoard();
  const { project } = ctx.board.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath: "/tmp/demo",
    projectType: "web",
  });
  return { ...ctx, project };
}

type Json = Record<string, any>;
type Contract = {
  name: string;
  input: { parse(v: unknown): unknown };
  output: { parse(v: unknown): unknown };
};

describe("projects", () => {
  it("creates, resolves by prefix or id, updates and archives", () => {
    const { board, project } = withProject();
    expect(board.projects.resolve("demo").id).toBe(project.id);
    expect(board.projects.update("DEMO", { name: "Renamed" }).project.name).toBe("Renamed");
    board.projects.update(project.id, { archived: true });
    expect(board.projects.list().projects).toHaveLength(0);
    expect(board.projects.list(true).projects).toHaveLength(1);
  });

  it("rejects bad and duplicate prefixes with coded errors", () => {
    const { board } = withProject();
    expect(() => board.projects.create({ name: "X", prefix: "bad", repoPath: "" })).toThrow(
      /\[invalid\]/,
    );
    expect(() => board.projects.create({ name: "Y", prefix: "DEMO", repoPath: "" })).toThrow(
      /\[conflict\]/,
    );
    expect(() => board.projects.resolve("NOPE")).toThrow(/\[not_found\]/);
  });
});

describe("cards", () => {
  it("creates in draft with keys, defaults and tag-derived evidence", () => {
    const { board } = withProject();
    const feature = board.tags.list().tags.find((t) => t.name === "feature")!;
    const { card } = board.cards.create({ project: "DEMO", title: "First", tagIds: [feature.id] });
    expect(card).toMatchObject({
      key: "DEMO-1",
      column: "draft",
      priority: "none",
      needsEvidence: true,
    });
    expect(card.tags).toEqual([feature.id]);
    expect(board.cards.create({ project: "DEMO", title: "Second" }).card.key).toBe("DEMO-2");
  });

  it("moves draft <-> todo for the user and refuses every other jump", () => {
    const { board } = withProject();
    const { card } = board.cards.create({ project: "DEMO", title: "A" });
    expect(board.cards.move(card.key, { to: "todo" }).card.column).toBe("todo");
    expect(board.cards.move(card.key, { to: "draft" }).card.column).toBe("draft");
    expect(() => board.cards.move(card.key, { to: "done" })).toThrow(/\[illegal_transition\]/);
    board.cards.move(card.key, { to: "todo" });
    expect(() => board.cards.move(card.key, { to: "in_progress" })).toThrow(
      /\[actor_not_allowed\]/,
    );
    expect(() => board.cards.move(card.key, { to: "todo" })).toThrow(/\[same_column\]/);
  });

  it("orders by sort key, reorders between neighbours, filters and searches", () => {
    const { board } = withProject();
    const a = board.cards.create({ project: "DEMO", title: "alpha", priority: "high" }).card;
    const b = board.cards.create({ project: "DEMO", title: "beta", description: "needle" }).card;
    const c = board.cards.create({ project: "DEMO", title: "gamma", priority: "high" }).card;
    expect(board.cards.list({ column: "draft" }).cards.map((x) => x.key)).toEqual([
      "DEMO-1",
      "DEMO-2",
      "DEMO-3",
    ]);

    board.cards.reorder(c.key, { afterCard: a.key, beforeCard: b.key });
    expect(board.cards.list({ project: "DEMO" }).cards.map((x) => x.key)).toEqual([
      "DEMO-1",
      "DEMO-3",
      "DEMO-2",
    ]);
    board.cards.reorder(c.key, { afterCard: null, beforeCard: a.key });
    expect(board.cards.list({}).cards[0]?.key).toBe("DEMO-3");

    expect(board.cards.list({ priority: "high" }).cards).toHaveLength(2);
    expect(board.cards.list({ search: "needle" }).cards.map((x) => x.key)).toEqual(["DEMO-2"]);
    expect(board.cards.list({ search: "demo-1" }).cards).toHaveLength(1);
    expect(board.cards.list({ limit: 2 })).toMatchObject({ truncated: true });
    expect(board.cards.list({ tagId: "tag_bug" }).cards).toHaveLength(0);
  });

  it("updates fields and tags atomically, keeps sub-cards, archives and deletes", () => {
    const { board } = withProject();
    const parent = board.cards.create({ project: "DEMO", title: "Parent" }).card;
    const child = board.cards.create({
      project: "DEMO",
      title: "Child",
      parentCardId: parent.key,
    }).card;
    expect(child.parentCardId).toBe(parent.id);
    const { card } = board.cards.update(parent.key, {
      title: "Parent 2",
      acceptance: "- [ ] done",
      priority: "urgent",
      tagIds: ["tag_bug", "tag_doc"],
      needsEvidence: true,
    });
    expect(card).toMatchObject({
      title: "Parent 2",
      acceptance: "- [ ] done",
      priority: "urgent",
      needsEvidence: true,
    });
    expect([...card.tags].sort()).toEqual(["tag_bug", "tag_doc"]);
    expect(() => board.cards.update(parent.key, { tagIds: ["tag_nope"] })).toThrow(/\[not_found\]/);
    expect([...board.cards.get(parent.key).tags].sort()).toEqual(["tag_bug", "tag_doc"]);
    expect(() => board.cards.update(parent.key, { parentCardId: parent.key })).toThrow(
      /own parent/,
    );
    expect(board.cards.detail(parent.key).children.map((c) => c.key)).toEqual([child.key]);

    expect(board.archive(child.key).card.archivedAt).not.toBeNull();
    expect(board.cards.list({}).cards.map((c) => c.key)).toEqual([parent.key]);
    expect(board.cards.list({ includeArchived: true }).cards).toHaveLength(2);
    expect(board.remove(child.key)).toEqual({ deleted: true });
    expect(() => board.cards.get(child.key)).toThrow(/\[not_found\]/);
  });

  it("summarises counts per project and column", () => {
    const { board } = withProject();
    const a = board.cards.create({ project: "DEMO", title: "A" }).card;
    board.cards.create({ project: "DEMO", title: "B" });
    board.cards.move(a.key, { to: "todo" });
    const summary = board.cards.summary();
    expect(summary.projects[0]?.counts).toMatchObject({ draft: 1, todo: 1 });
    expect(summary.totals).toMatchObject({ draft: 1, todo: 1, done: 0 });
  });

  it("writes vibe_event rows through the command layer", () => {
    const { board, runtime } = withProject();
    const { card } = board.cards.create({ project: "DEMO", title: "A" });
    board.cards.update(card.key, { title: "B" });
    board.cards.move(card.key, { to: "todo" });
    board.plans.save(card.key, {
      description: "d",
      checks: [{ text: "c" }],
      subCards: [],
      tags: [],
      recommendedPresetId: null,
    });
    expect(eventTypes(runtime)).toEqual([
      "card.created",
      "card.updated",
      "card.moved",
      "plan.updated",
    ]);
  });
});

describe("events, plans, tags, presets, attachments", () => {
  it("keeps a timeline and plan versions", () => {
    const { board } = withProject();
    const { card } = board.cards.create({ project: "DEMO", title: "A" });
    board.events.add(card.key, { text: "hello" });
    board.events.add(card.key, { text: "ping" }, agentActor("worker", "agent-1"));
    const events = board.events.list(card.key).events.filter((e) => e.type === "note");
    expect(events.map((e) => [e.type, e.authorKind, e.author, e.body])).toEqual([
      ["note", "user", "user", { text: "hello" }],
      ["note", "agent", "agent-1", { text: "ping" }],
    ]);
    expect(() => board.events.add(card.key, {})).toThrow(/text or body/);

    const snap = {
      description: "d",
      checks: [],
      subCards: [],
      tags: ["bug"],
      recommendedPresetId: null,
    };
    expect(board.plans.save(card.key, snap).version.version).toBe(1);
    expect(board.plans.save(card.key, { ...snap, notes: "v2" }).version.version).toBe(2);
    expect(board.plans.list(card.key).versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("manages the tag vocabulary and presets", () => {
    const { board } = withProject();
    expect(board.tags.list().tags.map((t) => t.name)).toEqual(
      expect.arrayContaining(["bug", "feature", "change", "refactor", "test", "doc", "research"]),
    );
    const { tag } = board.tags.create("perf", true);
    expect(() => board.tags.create("PERF")).toThrow(/\[conflict\]/);
    expect(() => board.tags.delete("tag_bug")).toThrow(/Built-in/);
    expect(board.tags.delete(tag.id)).toEqual({ deleted: true });

    const { preset } = board.presets.create({ name: "Fast", provider: "claude", model: "haiku" });
    expect(preset).toMatchObject({
      permissionMode: "accept-edits",
      environmentKind: "project-default",
    });
    expect(board.presets.update(preset.id, { model: "sonnet" }).preset.model).toBe("sonnet");
    const { card } = board.cards.create({ project: "DEMO", title: "A", presetId: preset.id });
    expect(card.presetId).toBe(preset.id);
    expect(board.presets.delete(preset.id)).toEqual({ deleted: true });
  });

  it("stores attachments as reference images and cleans refImages on delete", () => {
    const { board } = withProject();
    const { card } = board.cards.create({ project: "DEMO", title: "A" });
    const { attachment } = board.attachments.upload(card.key, {
      fileName: "../ref.png",
      bytes: PNG,
      mime: "application/octet-stream",
      asRefImage: true,
    });
    expect(attachment).toMatchObject({
      filename: "ref.png",
      mimeType: "image/png",
      sizeBytes: PNG.length,
    });
    expect(board.cards.get(card.key).refImages).toEqual([attachment.id]);
    expect(board.attachments.read(attachment.id).content.equals(PNG)).toBe(true);
    expect(board.cards.detail(card.key).attachments).toHaveLength(1);
    expect(() =>
      board.attachments.upload(card.key, { fileName: "x", bytes: new Uint8Array() }),
    ).toThrow(/empty/);
    expect(board.attachments.delete(attachment.id)).toEqual({ deleted: true });
    expect(board.cards.get(card.key).refImages).toEqual([]);
    expect(board.attachments.delete(attachment.id)).toEqual({ deleted: false });
  });
});

describe("rpc contract", () => {
  it("registers every contract exactly once with vibe.* names", () => {
    const { board } = withProject();
    const handled: string[] = [];
    registerBoardRpcs({ handle: (def: { name: string }) => handled.push(def.name) } as never, board, {
      dispatcher: {} as never,
      lifecycle: {} as never,
      sync: {} as never,
      replies: {} as never,
    });
    const names = Object.values(rpc.VIBE_BOARD_RPCS).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(handled.sort()).toEqual([...names].sort());
    expect(names.every((n) => n.startsWith("vibe."))).toBe(true);
  });

  it("serves handlers that satisfy their output schemas", async () => {
    const { board } = withProject();
    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    registerBoardRpcs(
      { handle: (def: { name: string }, fn: never) => handlers.set(def.name, fn) } as never,
      board,
    );
    const call = async (def: Contract, input: unknown): Promise<Json> =>
      def.output.parse(
        await handlers.get(def.name)!(def.input.parse(input), { paseo: {} }),
      ) as Json;

    const created = await call(rpc.cardsCreateRpc, { project: "DEMO", title: "Via rpc" });
    expect(created.card.column).toBe("draft");
    const moved = await call(rpc.cardsMoveRpc, { card: created.card.key, to: "todo" });
    expect(moved.card.column).toBe("todo");
    const uploaded = await call(rpc.attachmentsUploadRpc, {
      card: created.card.key,
      fileName: "a.png",
      base64: PNG.toString("base64"),
      asRefImage: true,
    });
    const downloaded = await call(rpc.attachmentsDownloadRpc, {
      attachmentId: uploaded.attachment.id,
    });
    expect(downloaded.base64).toBe(PNG.toString("base64"));
    const detail = await call(rpc.cardsGetRpc, { card: created.card.key });
    expect(detail.card.refImages).toEqual([uploaded.attachment.id]);
    await call(rpc.eventsAddRpc, { card: created.card.key, text: "hi" });
    const timeline = (await call(rpc.eventsListRpc, { card: created.card.key })).events;
    expect(timeline.map((e: Json) => e.type)).toEqual(["status", "status", "note"]);
    expect((await call(rpc.boardSummaryRpc, {})).totals.todo).toBe(1);
    expect((await call(rpc.projectsListRpc, {})).projects).toHaveLength(1);
    expect((await call(rpc.sessionsListRpc, {})).sessions).toEqual([]);
    await expect(call(rpc.cardsMoveRpc, { card: created.card.key, to: "done" })).rejects.toBeInstanceOf(
      BoardError,
    );
  });

  it("has no legacy tasks.* names in the server sources", () => {
    const files = ["../index.server.ts", "../server/service.ts", "../server/rpc.ts", "../shared/rpc/index.ts"];
    for (const file of files) {
      expect(readFileSync(join(here, file), "utf8")).not.toMatch(/tasks\./);
    }
  });
});

describe("MCP tools", () => {
  it("lists vibe_* tools, hides writes from verifiers and has no move tool", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "vibe_projects",
      "vibe_list",
      "vibe_show",
      "vibe_create",
      "vibe_update",
      "vibe_comment",
      "vibe_attach",
      "vibe_session_note",
    ]);
    expect(toolsForRole("verifier").map((t) => t.name)).toEqual([
      "vibe_projects",
      "vibe_list",
      "vibe_show",
      "vibe_comment",
    ]);
  });

  it("creates drafts, updates, comments and enforces roles", async () => {
    const { board } = withProject();
    const data = (r: { content: Array<{ text: string }> }): Json => JSON.parse(r.content[0]!.text);
    const created = await callMcpTool(
      "vibe_create",
      { project: "DEMO", title: "From agent", tags: ["bug"] },
      board,
      { agentId: "a1", role: "master" },
    );
    expect(data(created).card).toMatchObject({ column: "draft", key: "DEMO-1" });
    const updated = await callMcpTool(
      "vibe_update",
      { key: "DEMO-1", priority: "high", acceptance: "ok" },
      board,
      { role: "master" },
    );
    expect(data(updated).card.priority).toBe("high");
    await callMcpTool("vibe_comment", { key: "DEMO-1", body: "note" }, board, {
      agentId: "a1",
      role: "verifier",
    });
    expect(board.events.list("DEMO-1").events.find((e) => e.type === "note")).toMatchObject({
      authorKind: "agent",
      author: "a1",
    });
    const denied = await callMcpTool("vibe_update", { key: "DEMO-1", title: "x" }, board, {
      role: "verifier",
    });
    expect(denied.isError).toBe(true);
    expect(await callMcpTool("vibe_show", { key: "DEMO-99" }, board, {})).toMatchObject({
      isError: true,
    });
    const badTag = await callMcpTool(
      "vibe_create",
      { project: "DEMO", title: "t", tags: ["nope"] },
      board,
      {},
    );
    expect(badTag.isError).toBe(true);
  });
});

describe("bridge (HTTP MCP + CLI)", () => {
  it("serves the MCP protocol and the CLI with auth", async () => {
    const { board } = withProject();
    const bridge = await startBoardBridge(board, tempDir());
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${bridge.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    try {
      expect((await fetch(`${bridge.url}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
      const init = (await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" })).json()) as Json;
      expect(init.result.serverInfo.name).toBe("vibe-board");
      const list = (await (
        await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "x-vibe-role": "verifier" })
      ).json()) as Json;
      expect(list.result.tools).toHaveLength(4);
      const call = (await (
        await post(
          "/mcp",
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "vibe_create", arguments: { project: "DEMO", title: "Over http" } },
          },
          { "x-vibe-agent-id": "a9", "x-vibe-role": "master" },
        )
      ).json()) as Json;
      expect(JSON.parse(call.result.content[0].text).card.key).toBe("DEMO-1");
      expect(
        (await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status,
      ).toBe(204);

      const cli = (await (await post("/cli", { argv: ["list", "--json"], cwd: "/" })).json()) as Json;
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).cards).toHaveLength(1);
      expect(JSON.parse(readFileSync(bridge.bridgeFile, "utf8")).url).toBe(bridge.url);
    } finally {
      await bridge.close();
    }
  });
});

describe("CLI", () => {
  it("creates, moves between draft and todo, comments and lists", async () => {
    const { board } = withProject();
    const run = (...argv: string[]) => runBoardCli(argv, board, { cwd: tempDir() });
    expect((await run("project", "create", "--name", "Other", "--prefix", "OTH")).stdout).toContain(
      "OTH",
    );
    const created = await run(
      "create",
      "--project",
      "DEMO",
      "--title",
      "CLI card",
      "--priority",
      "high",
      "--tag",
      "bug",
      "--json",
    );
    const key = JSON.parse(created.stdout).card.key;
    expect(key).toBe("DEMO-1");
    expect((await run("move", key, "--to", "todo")).stdout).toBe("Moved DEMO-1 to todo");
    expect((await run("list", "--column", "todo")).stdout).toContain("CLI card");
    expect((await run("move", key, "--to", "draft")).stdout).toContain("draft");
    expect((await run("comment", key, "--body", "hello there")).exitCode).toBe(0);
    expect((await run("show", key)).stdout).toContain("hello there");
    expect((await run("update", key, "--acceptance", "- [ ] works", "--evidence")).exitCode).toBe(0);
    expect(board.cards.get(key)).toMatchObject({ acceptance: "- [ ] works", needsEvidence: true });
    expect((await run("tag", "list")).stdout).toContain("feature");
  });

  it("reports errors and refuses agent moves", async () => {
    const { board } = withProject();
    board.cards.create({ project: "DEMO", title: "A" });
    const bad = await runBoardCli(["move", "DEMO-1", "--to", "nowhere"], board);
    expect(bad).toMatchObject({ exitCode: 1 });
    expect(bad.stderr).toContain("invalid --to");
    const agentMove = await runBoardCli(["move", "DEMO-1", "--to", "todo"], board, {
      agentId: "a1",
      role: "master",
    });
    expect(agentMove.exitCode).toBe(1);
    expect(agentMove.stderr).toContain("actor_not_allowed");
    expect((await runBoardCli(["show", "NOPE-1"], board)).stderr).toContain("not_found");
    expect((await runBoardCli(["wat"], board)).stderr).toContain("unknown command");
  });

  it("round-trips attachments through files", async () => {
    const { board } = withProject();
    const dir = tempDir();
    writeFileSync(join(dir, "shot.png"), PNG);
    board.cards.create({ project: "DEMO", title: "A" });
    const added = await runBoardCli(
      ["attachment", "add", "DEMO-1", "--file", "shot.png", "--ref-image", "--json"],
      board,
      { cwd: dir },
    );
    const id = JSON.parse(added.stdout).attachment.id;
    const got = await runBoardCli(["attachment", "get", id, "--out", "copy.png"], board, {
      cwd: dir,
    });
    expect(got.exitCode).toBe(0);
    expect(readFileSync(join(dir, "copy.png")).equals(PNG)).toBe(true);
    expect((await runBoardCli(["attachment", "rm", id], board)).stdout).toBe("Deleted");
    unlinkSync(join(dir, "shot.png"));
    unlinkSync(join(dir, "copy.png"));
  });
});

describe("plugin entry", () => {
  it("registers settings, hooks, RPCs and a disposer", async () => {
    vi.stubEnv("VIBE_HOME", tempDir());
    const handlers: string[] = [];
    const hooks: string[] = [];
    const server = {
      registerSettings: () => ({
        read: async () => ({
          status: "ready",
          values: { autoInjectCliAndMcp: true, autoInjectInstructions: true },
        }),
      }),
      handle: (def: { name: string }) => handlers.push(def.name),
      before: (name: string) => (hooks.push(name), () => undefined),
      on: () => () => undefined,
    };
    const { default: contribute } = await import("../index.server");
    const dispose = contribute(server as never);
    expect(hooks).toEqual(["agent.create", "agent.session_open", "agent.session_open"]);
    expect(handlers).toHaveLength(
      Object.keys(rpc.VIBE_BOARD_RPCS).length + Object.keys(rpc.VIBE_VERIFY_UI_RPCS).length,
    );
    await (dispose as () => Promise<void>)();
    vi.unstubAllEnvs();
  });
});
