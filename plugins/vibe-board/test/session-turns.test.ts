import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerLifecycle } from "../server/lifecycle";
import { isSessionNotePath } from "../server/lifecycle/auto-approve";
import { expectSystemTurn } from "../server/lifecycle/system-turn";
import { setupBoard, tempDir } from "./helpers";

type Handler = (event: any, context: any) => unknown;

const respond = vi.fn(async (_: unknown) => {});
/** Fake SDK handle; `items` are the timeline tool calls the agent has emitted. */
const fakePaseo = (items: unknown[] = []) => ({
  agents: {
    ref: () => ({
      respondToPermission: respond,
      timeline: { refetch: async () => ({ entries: items.map((item) => ({ item })) }) },
    }),
  },
});

function setup(itemsFor: (worktree: string) => unknown[] = () => []) {
  const t = setupBoard();
  const project = t.runtime.store.projects.create({ name: "D", prefix: "DEMO", repoPath: "d:/repo" });
  const card = t.runtime.store.cards.create({ projectId: project.id, title: "Feature", column: "todo" });
  const worktree = join(tempDir("wt-"), "card");
  t.runtime.store.cards.dispatch({ cardId: card.id, agentId: "a1", provider: "codex", worktree });
  const systemTurnDir = tempDir("turns-");
  const items = itemsFor(worktree);

  const handlers = new Map<string, Handler[]>();
  const server = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    before: () => () => {},
  } as any;
  registerLifecycle(server, { board: t.board, log: () => {}, systemTurnDir });
  const emit = (name: string, event: unknown) =>
    Promise.all(
      (handlers.get(name) ?? []).map((h) =>
        h(event, { paseo: fakePaseo(items), signal: new AbortController().signal }),
      ),
    );
  const agent = { id: "a1", workspaceId: null, parentAgentId: null, provider: "codex", cwd: worktree, title: null };
  const ended = (turnId: string) =>
    emit("agent.turn_ended", { agent, turnId, outcome: { kind: "completed" }, timeline: [] });
  return {
    ...t,
    agent,
    worktree,
    systemTurnDir,
    emit,
    column: () => t.runtime.store.cards.get(card.id)!.column,
    state: () => t.runtime.store.sessions.getByAgent("a1")!.state,
    started: (turnId: string) => emit("agent.turn_started", { agent, turnId }),
    ended,
    ask: (request: Record<string, unknown>) =>
      emit("agent.permission_requested", { agent, request: { id: "r1", kind: "tool", name: "x", ...request } }),
  };
}

describe("system turns (plugin-started)", () => {
  it("does not pull a verifying card back to in_progress, but still tracks the session", async () => {
    const t = setup();
    await t.started("t");
    await t.ended("t"); // worker finishes -> verifying
    expect(t.column()).toBe("verifying");

    expectSystemTurn("a1", t.systemTurnDir);
    await t.started("s1");
    expect(t.column()).toBe("verifying");
    expect(t.state()).toBe("working");
    await t.ended("s1");
    expect(t.state()).toBe("idle");
    expect(t.column()).toBe("verifying");

    // the marker was consumed: the next turn is the user's and does move the card
    await t.started("u1");
    expect(t.column()).toBe("in_progress");
  });

  it("a system turn does not move an in_progress card to verifying", async () => {
    const t = setup();
    expectSystemTurn("a1", t.systemTurnDir);
    await t.started("s1");
    await t.ended("s1");
    expect(t.column()).toBe("in_progress");
    expect(t.state()).toBe("idle");
  });

  it("ignores an expired marker", async () => {
    const t = setup();
    await t.started("t");
    await t.ended("t");
    expectSystemTurn("a1", t.systemTurnDir, -1);
    await t.started("u1");
    expect(t.column()).toBe("in_progress");
  });
});

describe("session-note auto approval", () => {
  it("approves a write inside <worktree>/.vibe/sessions and nothing else", async () => {
    respond.mockClear();
    const t = setup();
    await t.started("t");
    await t.ask({ detail: { type: "write", filePath: join(t.worktree, ".vibe", "sessions", "DEMO-1.md") } });
    expect(respond).toHaveBeenCalledWith({ requestId: "r1", response: { behavior: "allow" } });
    expect(t.state()).toBe("working");

    respond.mockClear();
    for (const filePath of [
      join(t.worktree, "src", "a.ts"),
      join(t.worktree, ".vibe", "sessions", "..", "PROJECT_STATE.md"),
      join(t.worktree, "..", ".vibe", "sessions", "x.md"),
    ]) {
      await t.ask({ id: "r2", detail: { type: "write", filePath } });
      expect(respond).not.toHaveBeenCalled();
      expect(t.state()).toBe("waiting");
      await t.emit("agent.permission_resolved", { agent: t.agent, requestId: "r2", resolution: { behavior: "deny" } });
    }
  });

  it("resolves a path-less codex request through its timeline tool call", async () => {
    respond.mockClear();
    const call = (filePath: string) => ({ type: "tool_call", callId: "item1", detail: { type: "edit", filePath } });
    const note = setup((wt) => [call(join(wt, ".vibe", "sessions", "n.md"))]);
    const request = { name: "CodexFileChange", metadata: { itemId: "item1" } };
    await note.started("t");
    await note.ask(request);
    expect(respond).toHaveBeenCalledTimes(1);

    respond.mockClear();
    const source = setup((wt) => [call(join(wt, "src", "a.ts"))]);
    await source.started("t");
    await source.ask(request);
    await source.ask({ id: "r2", name: "CodexFileChange", metadata: { itemId: "unknown" } });
    expect(respond).not.toHaveBeenCalled();
    expect(source.state()).toBe("waiting");
  });

  it("path check", () => {
    const root = join(tempDir("p-"), "wt");
    expect(isSessionNotePath(root, ".vibe/sessions/a.md")).toBe(true);
    expect(isSessionNotePath(root, ".vibe/sessions")).toBe(false);
    expect(isSessionNotePath(root, ".vibe/sessions/../x.md")).toBe(false);
  });
});

describe("vibe_session_note", () => {
  it("writes the card's session notes into its worktree", async () => {
    const { callMcpTool } = await import("../server/mcp/tools");
    const { mkdirSync, readFileSync } = await import("node:fs");
    const t = setup();
    mkdirSync(t.worktree, { recursive: true });
    const card = t.runtime.store.cards.list({})[0]!;
    const ok = await callMcpTool("vibe_session_note", { key: card.key, text: "# notes" }, t.board, { agentId: "a1", role: "worker" });
    expect(ok.isError).toBeUndefined();
    expect(readFileSync(join(t.worktree, ".vibe", "sessions", `${card.id}.md`), "utf8")).toBe("# notes");
    const unknown = await callMcpTool("vibe_session_note", { key: "NOPE-1", text: "x" }, t.board, { role: "worker" });
    expect(unknown.isError).toBe(true);
    const verifier = await callMcpTool("vibe_session_note", { key: card.key, text: "x" }, t.board, { agentId: "a1", role: "verifier" });
    expect(verifier.isError).toBe(true);
  });
});

describe("session-note MCP tool approval", () => {
  it("approves vibe_session_note on the vibe-board server only", async () => {
    respond.mockClear();
    const t = setup();
    await t.started("t");
    const elicit = (serverName: string, tool: string) => ({
      name: "CodexMcpElicitation",
      description: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
      metadata: { serverName },
    });
    await t.ask({ id: "m1", ...elicit("vibe-board", "vibe_session_note") });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(t.state()).toBe("working");

    respond.mockClear();
    await t.ask({ id: "m2", ...elicit("vibe-board", "vibe_update") });
    await t.ask({ id: "m3", ...elicit("other", "vibe_session_note") });
    expect(respond).not.toHaveBeenCalled();
    expect(t.state()).toBe("waiting");
  });
});
