import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MASTER_RULES } from "../server/master/rules.generated";
import { createPlanning, handoffPath } from "../server/planning/planner";
import { PlanTurnSchema } from "../server/planning/schema";
import { messagesOf, threadState } from "../server/planning/thread";
import { createMasterRuntime } from "../server/runtime";
import { MasterError, type MasterPaseo } from "../server/types";
import type { MemoryPort } from "../server/memory/files";
import { ManualClock, defaultSettings, fakeMaster, fakePaseo, setupBoard, tempDir, type Script } from "./helpers";

const fence = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const memory: MemoryPort = {
  snapshot: () => ({
    "PROJECT_STATE.md": [{ id: "m_1", tag: "", body: "State: login screen exists", touched: "" }],
    "DECISIONS.md": [{ id: "m_2", tag: "ui", body: "Use the shared button component", touched: "" }],
    "LESSONS.md": [],
    "INDEX.md": [],
  }),
  apply: () => ({ stateWritten: false, added: 0, superseded: 0, archived: 0, duplicates: 0 }),
};

function setup(script: Script, options: { noPaseo?: boolean } = {}) {
  const board = setupBoard();
  const fake = fakePaseo(script);
  let paseo: MasterPaseo | null = options.noPaseo ? null : fake.paseo;
  let mode = "auto";
  const planning = createPlanning({
    db: board.db,
    store: board.store,
    getPaseo: () => paseo,
    master: fakeMaster(fake, () => mode),
    rules: MASTER_RULES,
    dataDir: tempDir("vibe-master-data-"),
    clock: new ManualClock(),
    memory,
    enabled: () => true,
    log: () => undefined,
  });
  const say = (cardId: string, text: string) =>
    board.store.cards.addChat({ cardId, authorKind: "user", author: "user", text });
  const requestHandoff = (cardId: string) =>
    board.store.events.add({
      cardId,
      type: "note",
      authorKind: "user",
      author: "user",
      body: { kind: "handoff_request" },
    });
  const discussion = (cardId: string) => messagesOf(board.store.events.list(cardId));
  return {
    ...board,
    fake,
    planning,
    say,
    requestHandoff,
    discussion,
    setPaseo(next: MasterPaseo | null) {
      paseo = next;
    },
    setMode(next: string) {
      mode = next;
    },
  };
}

const planA = {
  description: "Add a dark mode toggle to settings; persist in local storage.",
  checks: [{ text: "Toggle switches theme", method: "screenshot" }, { text: "npm test passes" }],
  subCards: [],
  tags: ["feature", "unknown-tag"],
  recommendedPreset: "Codex Max",
  notes: "Risk: charts hard-code colors.",
  files: ["src/settings/**", "src/theme.ts"],
};

describe("thread state", () => {
  it("derives unanswered messages from the events alone", () => {
    const t = setup(() => "");
    const draft = t.draft("Thread");
    const first = t.say(draft.id, "hello");
    t.store.cards.addChat({
      cardId: draft.id,
      authorKind: "master",
      author: "planner",
      text: "hi",
      answers: [first.id],
    });
    const second = t.say(draft.id, "more");
    t.requestHandoff(draft.id);
    const state = threadState(t.store.events.list(draft.id), { column: "draft", executorOnline: false });
    expect(state.pending.map((m) => m.id)).toEqual([second.id]);
    expect(state.handoffRequests).toHaveLength(1);
    expect(state.hasDiscussion).toBe(true);
  });

  it("validates planner replies", () => {
    expect(PlanTurnSchema.safeParse({ reply: "ok" }).success).toBe(true);
    expect(PlanTurnSchema.safeParse({ reply: "" }).success).toBe(false);
    expect(
      PlanTurnSchema.safeParse({ reply: "x", research: Array(4).fill({ question: "q" }) }).success,
    ).toBe(false);
  });
});

describe("planning session", () => {
  it("runs a 3-round discussion in its own agent, writes plan versions and hands off on request", async () => {
    let round = 0;
    const t = setup(({ prompt, agentId }) => {
      if (prompt.startsWith("[plan:handoff]")) {
        return fence({ summary: "# Hand-off\nDark mode toggle, see plan v2." });
      }
      round++;
      if (round === 1) return fence({ reply: "Which screens? Is OS theme in scope?" });
      if (round === 2) return fence({ reply: "Draft plan written.", plan: planA });
      return fence({
        reply: "Plan is final.",
        plan: { ...planA, description: `${planA.description} Respect OS theme by default.` },
        ready: true,
      });
    });
    const card = t.draft("Dark mode", { description: "Users want dark mode" });
    t.say(card.id, "Let's plan dark mode");
    await t.planning.tick();

    // round 1: separate agent with role planner, card context in the first message
    expect(t.fake.agents).toHaveLength(1);
    const agent = t.fake.agents[0]!;
    expect(agent.options.labels).toMatchObject({ role: "planner" });
    expect(agent.options.config.systemPrompt).toBe(MASTER_RULES);
    expect(agent.prompts[0]).toContain("[plan:start]");
    expect(agent.prompts[0]).toContain("Dark mode");
    expect(agent.prompts[0]).toContain("Use the shared button component");
    const live = t.planning.liveOf(card.id)!;
    expect(live.role).toBe("planner");
    expect(live.state).toBe("idle");
    expect(t.store.cards.get(card.id)!.planSessionId).toBe(live.id);
    expect(t.discussion(card.id).map((m) => m.role)).toEqual(["user", "planner"]);
    expect(t.store.plans.list(card.id)).toHaveLength(0);

    // round 2: same agent, plan written back as version 1 with preset + tag filtering
    t.say(card.id, "Settings screen only; OS theme out of scope");
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(1);
    expect(agent.prompts[1]).toContain("[plan:turn]");
    const v1 = t.store.plans.list(card.id);
    expect(v1).toHaveLength(1);
    expect(v1[0]!.snapshot.tags).toEqual(["feature"]);
    expect(v1[0]!.snapshot.files).toEqual(["src/settings/**", "src/theme.ts"]);
    expect(v1[0]!.snapshot.recommendedPresetId).toBe(t.presets.codex.id);
    expect(t.store.cards.get(card.id)!.suggestedPresetId).toBe(t.presets.codex.id);

    // round 3: consensus changes -> version 2, ready hint, card not moved
    t.say(card.id, "Actually follow the OS theme by default");
    await t.planning.tick();
    expect(t.store.plans.list(card.id).map((p) => p.version)).toEqual([1, 2]);
    const last = t.store.events
      .list(card.id)
      .filter((e) => e.type === "chat" && e.authorKind === "master")
      .at(-1)!;
    expect(last.body).toMatchObject({ ready: true, planVersion: 2, agentId: agent.id, sessionId: live.id });
    expect(t.store.cards.get(card.id)!.column).toBe("draft");
    expect(t.discussion(card.id).filter((m) => m.role === "planner")).toHaveLength(3);
    expect(t.eventTypes()).toContain("plan.updated");

    // hand-off: summary into .vibe/sessions/<KEY>-plan.md, session archived, card still draft
    t.requestHandoff(card.id);
    await t.planning.tick();
    const file = handoffPath(t.repoPath, card.key);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Dark mode toggle, see plan v2.");
    expect(file.replaceAll("\\", "/")).toMatch(/\.vibe\/sessions\/DEMO-1-plan\.md$/);
    expect(t.planning.liveOf(card.id)).toBeUndefined();
    expect(t.store.sessions.get(live.id)!.state).toBe("ended");
    expect(agent.archived).toBe(true);
    expect(t.store.cards.get(card.id)!.column).toBe("draft");
    const handoff = t.store.events.list(card.id).find((e) => (e.body as { kind?: string }).kind === "handoff")!;
    expect(handoff.body).toMatchObject({ path: file });
    expect(
      threadState(t.store.events.list(card.id), { column: "draft", executorOnline: false }).handoffRequests,
    ).toHaveLength(0);
  });

  it("runs read-only scouts, shows their findings and feeds them back", async () => {
    const t = setup(({ prompt, agentId }) => {
      if (prompt.includes("read-only scout")) return "settings.ts holds the theme; about 2 files, small change.";
      if (prompt.startsWith("[plan:research_results]")) {
        return fence({ reply: "Scout says: small change in settings.ts." });
      }
      return fence({ reply: "Let me check.", research: [{ question: "Where is the theme set?", scope: "src/" }] });
    });
    const card = t.draft("Scouted");
    t.say(card.id, "How big is this?");
    await t.planning.tick();

    const scouts = t.fake.agents.filter((a) => (a.options.labels as Record<string, string>).role === "scout");
    expect(scouts).toHaveLength(1);
    expect(scouts[0]!.options.cwd).toBe(t.repoPath);
    expect(scouts[0]!.options.config.modeId).toBe("plan");
    expect(scouts[0]!.archived).toBe(true);
    const planner = t.fake.agents.find((a) => (a.options.labels as Record<string, string>).role === "planner")!;
    expect(planner.prompts[1]).toContain("settings.ts holds the theme");
    const events = t.store.events.list(card.id);
    const findings = events.find((e) => e.type === "chat" && e.authorKind === "scout")!;
    expect(findings.body).toMatchObject({ kind: "summary", key: `research:${events.find((e) => e.type === "chat" && e.authorKind === "user")!.id}:1` });
    expect((findings.body as { text: string }).text).toContain("settings.ts holds the theme");
    expect(t.discussion(card.id).at(-1)!.text).toContain("small change in settings.ts");
    // scouts are not board sessions
    expect(t.store.sessions.list({ cardId: card.id }).map((s) => s.role)).toEqual(["planner"]);
  });

  it("hands off and archives when the card is moved to todo by the owner", async () => {
    const t = setup(({ prompt }) => {
      if (prompt.startsWith("[plan:handoff]")) return fence({ summary: "Late summary" });
      return fence({ reply: "ok", plan: planA });
    });
    const card = t.draft("Late move");
    t.say(card.id, "go");
    await t.planning.tick();
    t.store.cards.move(card.id, { to: "todo", actor: "user" });
    await t.planning.tick();
    expect(readFileSync(handoffPath(t.repoPath, card.key), "utf8")).toContain("Late summary");
    expect(t.planning.liveOf(card.id)).toBeUndefined();
    expect(t.fake.agents[0]!.archived).toBe(true);
    // the discussion may go on in todo: a fresh planner answers
    t.say(card.id, "still there?");
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(2);
    expect(t.discussion(card.id).at(-1)!.role).toBe("planner");
  });

  it("falls back to a deterministic summary when the planner cannot write one", async () => {
    const t = setup(({ prompt }) => {
      if (prompt.startsWith("[plan:handoff]")) return "not json at all";
      return fence({ reply: "ok", plan: planA });
    });
    const card = t.draft("Fallback");
    t.say(card.id, "go");
    await t.planning.tick();
    t.requestHandoff(card.id);
    await t.planning.tick();
    const text = readFileSync(handoffPath(t.repoPath, card.key), "utf8");
    expect(text).toContain("# Hand-off: DEMO-1 Fallback");
    expect(text).toContain(planA.description);
  });

  it("keeps an answer when the reply is not JSON, and reports failures to the owner", async () => {
    let fail = false;
    const t = setup(() => {
      if (fail) return { status: "error" as const, lastMessage: null, error: "boom" };
      return "Just prose, no JSON.";
    });
    const card = t.draft("Prose");
    t.say(card.id, "hello");
    await t.planning.tick();
    expect(t.discussion(card.id).at(-1)!.text).toBe("Just prose, no JSON.");

    fail = true;
    const msg = t.say(card.id, "again");
    await t.planning.tick();
    const failure = t.store.events.list(card.id).at(-1)!;
    expect(failure.type).toBe("chat");
    expect(failure.body).toMatchObject({ error: true, answers: [msg.id] });
    expect(t.planning.liveOf(card.id)!.state).toBe("error");
    // the session recovers on the next message
    fail = false;
    t.say(card.id, "retry");
    await t.planning.tick();
    expect(t.discussion(card.id).at(-1)!.text).toBe("Just prose, no JSON.");
    expect(t.planning.liveOf(card.id)!.state).toBe("idle");
  });

  it("waits for the daemon handle and resumes; a restart reuses the live agent", async () => {
    const t = setup(() => fence({ reply: "answer" }), { noPaseo: true });
    const card = t.draft("Parked");
    t.say(card.id, "first");
    await t.planning.tick();
    expect(t.discussion(card.id)).toHaveLength(1);

    t.setPaseo(t.fake.paseo);
    await t.planning.resume();
    expect(t.discussion(card.id).map((m) => m.role)).toEqual(["user", "planner"]);
    expect(t.fake.agents).toHaveLength(1);

    // a second planning instance on the same db (daemon restart) attaches to the same agent
    const again = createPlanning({
      db: t.db,
      store: t.store,
      getPaseo: () => t.fake.paseo,
      master: fakeMaster(t.fake),
      rules: MASTER_RULES,
      dataDir: tempDir("vibe-master-data-"),
      clock: new ManualClock(),
      memory,
      enabled: () => true,
      log: () => undefined,
    });
    t.say(card.id, "second");
    await again.tick();
    expect(t.fake.agents).toHaveLength(1);
    expect(t.fake.agents[0]!.prompts).toHaveLength(2);
    expect(t.discussion(card.id).map((m) => m.role)).toEqual(["user", "planner", "user", "planner"]);
  });

  it("starts a fresh session seeded with the earlier discussion after the old agent is gone", async () => {
    const t = setup(() => fence({ reply: "fine" }));
    const card = t.draft("Reseed");
    t.say(card.id, "one");
    await t.planning.tick();
    t.fake.agents[0]!.archived = true; // refresh() now reports the agent as gone
    t.say(card.id, "two");
    const restarted = createPlanning({
      db: t.db,
      store: t.store,
      getPaseo: () => t.fake.paseo,
      master: fakeMaster(t.fake),
      rules: MASTER_RULES,
      dataDir: tempDir("vibe-master-data-"),
      clock: new ManualClock(),
      memory,
      enabled: () => true,
      log: () => undefined,
    });
    await restarted.tick();
    expect(t.fake.agents).toHaveLength(2);
    expect(t.fake.agents[1]!.prompts[0]).toContain("Discussion so far");
    expect(t.fake.agents[1]!.prompts[0]).toContain("OWNER: one");
    expect(t.store.sessions.list({ cardId: card.id }).map((s) => s.state)).toEqual(["ended", "idle"]);
  });

  it("starts planners in the automatic permission mode and restarts one seeded when the mode changes", async () => {
    const t = setup(() => fence({ reply: "fine" }));
    const card = t.draft("Mode switch");
    t.say(card.id, "one");
    await t.planning.tick();
    expect(t.fake.agents[0]!.options.config.modeId).toBe("auto");

    t.say(card.id, "two");
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(1); // same mode: the planner is reused

    t.setMode("acceptEdits");
    t.say(card.id, "three");
    await t.planning.tick();
    expect(t.fake.agents).toHaveLength(2);
    expect(t.fake.agents[0]!.archived).toBe(true);
    expect(t.fake.agents[1]!.options.config.modeId).toBe("acceptEdits");
    expect(t.fake.agents[1]!.prompts[0]).toContain("OWNER: one");
    expect(t.discussion(card.id).map((m) => m.role)).toEqual(["user", "planner", "user", "planner", "user", "planner"]);
  });

  it("MasterError kinds stay distinguishable", () => {
    expect(new MasterError("unavailable", "x").kind).toBe("unavailable");
  });
});

describe("planning inside the master runtime", () => {
  it("uses its own agents (not the master's), and assessment steps aside while a planner is live", async () => {
    const board = setupBoard();
    const fake = fakePaseo(({ prompt }) =>
      prompt.startsWith("[wake:assess_draft]") ? "{}" : fence({ reply: "planner answer" }),
    );
    const runtime = createMasterRuntime({
      db: board.db,
      store: board.store,
      getPaseo: () => fake.paseo,
      settings: () => defaultSettings(),
      dataDir: tempDir(),
      clock: new ManualClock(),
      pollIntervalMs: 3_600_000,
      log: () => undefined,
    });
    const card = board.draft("Runtime planning");
    board.store.cards.addChat({ cardId: card.id, authorKind: "user", author: "user", text: "let us plan" });
    await runtime.planning.tick();
    expect(fake.agents.map((a) => (a.options.labels as Record<string, string>).role)).toEqual(["planner"]);
    expect(board.store.sessions.list({ role: "master" })).toHaveLength(0);

    runtime.wake(card.key, "assess_draft", true);
    await runtime.queue.idle();
    expect(fake.agents).toHaveLength(1);
    expect(board.store.events.list(card.id).some((e) => e.type === "evaluation")).toBe(false);
    await runtime.dispose();
  });
});
