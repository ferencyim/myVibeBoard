// Per-card planning sessions (WP-33). Each draft card that the owner discusses gets its own Paseo
// agent (role=planner, same model and rules as the master, own context), so discussions never
// pollute the master's main session. The conversation is the card's group chat, `chat` events
// (see thread.ts); this module polls for unanswered owner messages, runs one turn per batch
// (optionally with read-only scout sub-agents), writes the agreed plan back as a plan version and,
// when the owner moves the card on, writes a hand-off summary to `.vibe/sessions/<KEY>-plan.md`
// and archives the session. It never moves a card and never edits the card's title, description or
// acceptance: changes are suggested as proposals that the owner accepts in the chat.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReply } from "../assess/parse";
import { proposeChanges } from "../assess/proposal";
import type { Clock } from "../clock";
import { buildProjectBlock } from "../master/prompts";
import type { MasterSession } from "../master/session";
import type { MemoryPort } from "../memory/files";
import { defaultPromptPort, hashText, rulesUpdateMessage, type PromptPort } from "../prompts/port";
import { defaultTuning, type TuningSource } from "../tuning";
import type { Alerts } from "../subscription/alerts";
import { isQuotaError } from "../subscription/quota";
import { providerSpec } from "../subscription/target";
import { MasterError, type MasterAgentHandle, type MasterPaseo } from "../types";
import type { AgentSession, CardView, Preset, Project } from "../vibe/contract";
import type { VibeDb, VibeStore } from "../vibe/db";
import {
  buildHandoffMessage,
  buildRepairMessage,
  buildResultsMessage,
  buildScoutMessage,
  buildStartMessage,
  buildTurnMessage,
  fallbackHandoff,
  renderPlan,
  type ResearchItem,
} from "./prompts";
import { HandoffSchema, PlanTurnSchema, type PlanTurn } from "./schema";
import {
  HANDOFF,
  PLANNER_AUTHOR,
  messagesOf,
  threadState,
  type ThreadState,
} from "./thread";

const LIVE = ["starting", "working", "waiting", "idle", "error"] as const;
/** Worker states that mean an executing agent can receive the owner's chat messages. */
const EXECUTOR_ONLINE = ["starting", "working", "waiting", "idle"] as const;
/** Read-only mode of the known providers; any other provider is looked up in its mode catalog. */
const SCOUT_MODE: Record<string, string> = { claude: "plan", codex: "read-only" };
const READ_ONLY_MODE = /^(plan|read[-_ ]?only)$/i;

async function scoutModeOf(paseo: MasterPaseo, provider: string): Promise<string | undefined> {
  const known = SCOUT_MODE[provider];
  if (known) return known;
  try {
    const res = await paseo.providers.listModes?.(provider);
    return res?.modes?.find((m) => READ_ONLY_MODE.test(m.id) || READ_ONLY_MODE.test(m.label))?.id;
  } catch {
    return undefined; // the provider's default mode
  }
}

export interface PlanningDeps {
  db: VibeDb;
  store: VibeStore;
  getPaseo(): MasterPaseo | null;
  /** The master session: its current subscription decides model/provider of new planners. */
  master: Pick<MasterSession, "currentTarget" | "permission">;
  /** The system prompt in effect for a project scope (rules body + supplement). */
  rules(projectId?: string | null): string;
  /** Prompt texts (registry); defaults when omitted. */
  prompts?: PromptPort;
  /** Automation parameters (settings); defaults when omitted. */
  tuning?: TuningSource;
  /** Max characters of the requirements document in the project block (settings). */
  requirementsChars?(): number;
  /** `<VIBE_HOME>/master`; planner scratch workspaces live under `planning/<KEY>`. */
  dataDir: string;
  clock: Clock;
  memory: MemoryPort;
  alerts?: Alerts;
  enabled(): boolean;
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** Task id of the hand-off summary (vibe-context `layout.sessionMd(taskId)` convention). */
export const handoffTaskId = (cardKey: string) => `${cardKey}-plan`;

/** Where the hand-off summary of a card is written: `<repo>/.vibe/sessions/<KEY>-plan.md`. */
export function handoffPath(repoPath: string, cardKey: string): string {
  return join(repoPath, ".vibe", "sessions", `${handoffTaskId(cardKey)}.md`);
}

interface Live {
  agent: MasterAgentHandle;
  session: AgentSession;
  rulesSent: boolean;
  /** Hash of the rules text the agent has seen. */
  rulesHash: string;
  fresh: boolean;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createPlanning(deps: PlanningDeps) {
  const { store, db, clock } = deps;
  const log = deps.log ?? (() => undefined);
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.tuning ?? defaultTuning;
  const handles = new Map<
    string,
    {
      agent: MasterAgentHandle;
      sessionId: string;
      rulesSent: boolean;
      rulesHash: string;
      modeId?: string | null;
    }
  >();
  const chains = new Map<string, Promise<void>>();
  const parked = new Set<string>();
  let cursor = 0;
  let stopTimer: (() => void) | null = null;
  let running = false;

  // ---------- helpers ----------

  const liveOf = (cardId: string): AgentSession | undefined =>
    store.sessions.list({ cardId, role: "planner", states: LIVE }).at(-1);

  function moveSession(
    s: AgentSession | undefined,
    to: AgentSession["state"],
    opts: { message?: string; outcome?: string } = {},
  ) {
    if (!s) return;
    try {
      const current = store.sessions.get(s.id);
      if (current && current.state !== to) store.sessions.setState(s.id, to, opts);
    } catch (error) {
      log(`planner session state ${to} rejected`, error);
    }
  }

  const presetName = (id: string) => store.presets.list().find((p) => p.id === id)?.name ?? null;
  const tagNames = (card: CardView) => {
    const all = store.tags.list();
    return card.tags.map((id) => all.find((t) => t.id === id)?.name).filter((n): n is string => !!n);
  };

  function context(card: CardView) {
    const project = store.projects.get(card.projectId) as Project;
    const tags = store.tags.list();
    const presets = store.presets.list();
    const openCards = store.cards
      .list({ projectId: card.projectId })
      .filter((c) => c.id !== card.id && c.column !== "done");
    return { project, tags, presets, openCards };
  }

  function memoryText(project: Project): string {
    if (!project.repoPath) return "";
    try {
      return Object.entries(deps.memory.snapshot(project.repoPath))
        .map(([file, entries]) => {
          const lines = entries.map((e) => {
            const flat = e.body.replace(/\s+/g, " ");
            return `- ${e.tag ? `(${e.tag}) ` : ""}${flat.length > 300 ? `${flat.slice(0, 299)}…` : flat}`;
          });
          return lines.length ? `### ${file}\n${lines.join("\n")}` : "";
        })
        .filter(Boolean)
        .join("\n");
    } catch {
      return "";
    }
  }

  const executorOnline = (cardId: string) =>
    store.sessions.list({ cardId, role: "worker", states: EXECUTOR_ONLINE }).length > 0;
  const stateOf = (card: CardView) =>
    threadState(store.events.list(card.id), { column: card.column, executorOnline: executorOnline(card.id) });

  /** Hand-off notes stay `note` events (dispatch reads them). */
  function post(card: Pick<CardView, "id">, body: Record<string, unknown>) {
    return store.events.add({
      cardId: card.id,
      type: "note",
      authorKind: "agent",
      author: PLANNER_AUTHOR,
      body,
    });
  }

  // ---------- agent lifecycle ----------

  async function spawn(card: CardView): Promise<Live> {
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
    const target = await deps.master.currentTarget();
    const cwd = join(deps.dataDir, "planning", card.key);
    mkdirSync(cwd, { recursive: true });
    const modeId = (await deps.master.permission()).resolved.modeId;
    const rules = deps.rules(card.projectId);
    const created = await paseo.agents.create({
      cwd,
      title: `Plan ${card.key} · ${card.title}`.slice(0, 80),
      labels: { role: "planner", card: card.key },
      env: { VIBE_ROLE: "planner", VIBE_CARD_ID: card.id, VIBE_CARD_KEY: card.key },
      config: {
        provider: providerSpec(target),
        systemPrompt: rules,
        ...(target.thinking ? { thinkingOptionId: target.thinking } : {}),
        ...(modeId ? { modeId } : {}),
      },
    });
    const session = store.sessions.start({
      cardId: card.id,
      agentId: created.id,
      role: "planner",
      provider: target.provider,
    });
    store.cards.update(card.id, { planSessionId: session.id });
    const rulesSent = target.provider === "claude";
    const rulesHash = hashText(rules);
    handles.set(card.id, { agent: created, sessionId: session.id, rulesSent, rulesHash, modeId });
    log(`planner ${created.id} for ${card.key} started on ${providerSpec(target)}`);
    return { agent: created, session, rulesSent, rulesHash, fresh: true };
  }

  /** The planner of this card: the live one, or a fresh one seeded with the whole context. */
  async function ensure(card: CardView): Promise<Live> {
    const live = liveOf(card.id);
    const cached = handles.get(card.id);
    if (live && cached && cached.sessionId === live.id) {
      // The permission mode changed since this planner started: no in-place change exists, so the
      // discussion moves to a fresh planner seeded with the whole thread (the card holds it all).
      const wanted = (await deps.master.permission()).resolved.modeId;
      if (cached.modeId === undefined || cached.modeId === wanted) {
        return {
          agent: cached.agent,
          session: live,
          rulesSent: cached.rulesSent,
          rulesHash: cached.rulesHash,
          fresh: false,
        };
      }
      log(`planner for ${card.key}: permission mode changed (${cached.modeId} -> ${wanted}), restarting`);
      await archive(card, "mode_changed");
      return spawn(card);
    }
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
    if (live) {
      const candidate = paseo.agents.ref(live.agentId);
      const alive = await candidate.refresh().then(
        (r) => r != null,
        () => false,
      );
      if (alive) {
        // After a restart nothing records what the agent saw: assume the current rules.
        const rulesHash = hashText(deps.rules(card.projectId));
        handles.set(card.id, { agent: candidate, sessionId: live.id, rulesSent: true, rulesHash });
        return { agent: candidate, session: live, rulesSent: true, rulesHash, fresh: false };
      }
      moveSession(live, "ended", { outcome: "lost" });
      handles.delete(card.id);
    }
    return spawn(card);
  }

  async function archive(card: Pick<CardView, "id">, outcome: string): Promise<void> {
    const live = liveOf(card.id);
    const handle = handles.get(card.id);
    handles.delete(card.id);
    moveSession(live, "ended", { outcome });
    if (!live) return;
    try {
      await (handle?.agent ?? deps.getPaseo()?.agents.ref(live.agentId))?.archive();
    } catch (error) {
      log(`could not archive planner agent ${live.agentId}`, error);
    }
  }

  async function ask(
    live: Live,
    card: Pick<CardView, "id" | "projectId">,
    prompt: string,
  ): Promise<string> {
    moveSession(live.session, "working");
    const rules = deps.rules(card.projectId);
    const rulesHash = hashText(rules);
    const message = !live.rulesSent
      ? `${rules}\n\n---\n\n${prompt}`
      : rulesHash !== live.rulesHash
        ? `${rulesUpdateMessage(prompts, rules, card.projectId)}\n\n---\n\n${prompt}`
        : prompt;
    const fail = (failure: MasterError): never => {
      moveSession(live.session, "error", { message: failure.message });
      if (failure.kind === "quota") {
        deps.alerts?.raise("quota_error", live.session.currentProvider, failure.message);
      }
      throw failure;
    };
    const classify = (text: string) => new MasterError(isQuotaError(text) ? "quota" : "agent", text);
    let result;
    try {
      result = await live.agent.run(message, { timeoutMs: tuning().planTurnTimeoutMs });
    } catch (error) {
      return fail(classify(errorText(error)));
    }
    if (result.status === "error") {
      return fail(classify(result.error ?? "The planning agent failed without a message"));
    }
    if (result.status === "permission") {
      return fail(new MasterError("permission", "The planning agent is waiting for a permission"));
    }
    if (result.status === "timeout") {
      return fail(new MasterError("timeout", "The planning agent did not answer in time"));
    }
    if (!result.lastMessage?.trim()) {
      return fail(new MasterError("agent", "The planning agent returned an empty reply"));
    }
    live.rulesSent = true;
    live.rulesHash = rulesHash;
    const cached = handles.get(card.id);
    if (cached) {
      cached.rulesSent = true;
      cached.rulesHash = rulesHash;
    }
    return result.lastMessage;
  }

  /** Parse a reply into a PlanTurn; repair rounds (settings), then the raw text is the reply (the owner still gets an answer). */
  async function askTurn(live: Live, card: CardView, prompt: string): Promise<PlanTurn> {
    let reply = await ask(live, card, prompt);
    let parsed = parseReply(reply, PlanTurnSchema);
    for (let retry = 0; retry < tuning().jsonRepairRetries && !parsed.ok; retry++) {
      log(`planner reply for ${card.key} rejected, asking for a fix: ${parsed.error}`);
      try {
        reply = await ask(live, card, buildRepairMessage(parsed.error, prompts, card.projectId));
        parsed = parseReply(reply, PlanTurnSchema);
      } catch (error) {
        if (!(error instanceof MasterError) || error.kind === "unavailable") throw error;
        break;
      }
    }
    if (parsed.ok) return parsed.value;
    return PlanTurnSchema.parse({ reply: reply.trim() || "(empty reply)", research: [] });
  }

  // ---------- scouts ----------

  async function research(
    card: CardView,
    project: Project,
    requests: PlanTurn["research"],
  ): Promise<ResearchItem[]> {
    const paseo = deps.getPaseo();
    if (!paseo || !project.repoPath) {
      const why = !project.repoPath ? "the project has no repoPath" : "no daemon handle";
      return requests.map((r) => ({ ...r, ok: false, answer: `cannot run a scout: ${why}` }));
    }
    const target = await deps.master.currentTarget();
    const modeId = await scoutModeOf(paseo, target.provider);
    return Promise.all(
      requests.map(async (r): Promise<ResearchItem> => {
        let agent: MasterAgentHandle | null = null;
        try {
          agent = await paseo.agents.create({
            cwd: project.repoPath,
            title: `Scout ${card.key}`,
            labels: { role: "scout", card: card.key },
            env: { VIBE_ROLE: "scout", VIBE_CARD_KEY: card.key },
            config: { provider: providerSpec(target), ...(modeId ? { modeId } : {}) },
          });
          const out = await agent.run(
            buildScoutMessage({ card, question: r.question, scope: r.scope, prompts }),
            { timeoutMs: tuning().scoutTimeoutMs },
          );
          const answer = out.lastMessage?.trim();
          if (answer) return { ...r, ok: true, answer: answer.slice(0, 4000) };
          return { ...r, ok: false, answer: out.error ?? `scout ended with status ${out.status}` };
        } catch (error) {
          return { ...r, ok: false, answer: errorText(error) };
        } finally {
          await agent?.archive().catch(() => undefined);
        }
      }),
    );
  }

  // ---------- write-back ----------

  /** Save the agreed plan as the next plan version (unchanged plans do not create versions). */
  function applyPlan(card: CardView, plan: NonNullable<PlanTurn["plan"]>): number {
    const wanted = plan.recommendedPreset?.trim().toLowerCase();
    const preset: Preset | undefined = wanted
      ? store.presets
          .list()
          .find((p) => p.id === plan.recommendedPreset || p.name.toLowerCase() === wanted)
      : undefined;
    const vocabulary = new Map(store.tags.list().map((t) => [t.name.toLowerCase(), t.name]));
    const tags = [
      ...new Set(plan.tags.map((t) => vocabulary.get(t.toLowerCase())).filter((t): t is string => !!t)),
    ];
    const snapshot = {
      description: plan.description,
      checks: plan.checks.map((c) => (c.method ? { text: c.text, method: c.method } : { text: c.text })),
      subCards: plan.subCards,
      tags,
      recommendedPresetId: preset?.id ?? null,
      ...(plan.notes ? { notes: plan.notes } : {}),
      ...(plan.files?.length ? { files: plan.files } : {}),
    };
    const latest = store.plans.list(card.id).at(-1);
    if (latest && JSON.stringify(latest.snapshot) === JSON.stringify(snapshot)) return latest.version;
    return db.immediate(() => {
      const saved = store.plans.save(card.id, snapshot);
      if (preset && preset.id !== card.suggestedPresetId) {
        store.cards.update(card.id, { suggestedPresetId: preset.id });
      }
      return saved.version;
    });
  }

  // ---------- one discussion turn ----------

  async function turn(card: CardView, state: ThreadState): Promise<void> {
    const pending = state.pending;
    const answers = pending.map((m) => m.id);
    const { project, tags, presets, openCards } = context(card);
    let live: Live | undefined;
    const reply = (text: string, extra: { planVersion?: number; ready?: boolean; error?: boolean } = {}) =>
      store.cards.addChat({
        cardId: card.id,
        authorKind: "master",
        author: PLANNER_AUTHOR,
        text,
        answers,
        key: `reply:${answers.join("+")}`,
        ...(live ? { agentId: live.agent.id, sessionId: live.session.id } : {}),
        ...extra,
      });
    try {
      live = await ensure(card);
      const events = store.events.list(card.id);
      const prompt = live.fresh
        ? buildStartMessage({
            projectBlock: buildProjectBlock({
              project,
              tags,
              presets,
              openCards,
              requirementsChars: deps.requirementsChars?.(),
              cardLimit: tuning().projectBlockCardLimit,
            }),
            memory: memoryText(project),
            card,
            tagNames: tagNames(card),
            plan: renderPlan(store.plans.list(card.id).at(-1)?.snapshot, presetName),
            earlier: messagesOf(events).filter((m) => !answers.includes(m.id)),
            pending,
            prompts,
          })
        : buildTurnMessage(pending, prompts, card.projectId);
      let result = await askTurn(live, card, prompt);
      for (let round = 0; round < tuning().maxResearchRounds && result.research.length > 0; round++) {
        const items = await research(card, project, result.research);
        store.cards.addChat({
          cardId: card.id,
          authorKind: "scout",
          author: "scout",
          kind: "summary",
          text: items
            .map((r) => `Q: ${r.question}\n${r.ok ? r.answer : `(failed) ${r.answer}`}`)
            .join("\n\n"),
          key: `research:${answers[0]}:${round + 1}`,
        });
        result = await askTurn(live, card, buildResultsMessage(items, prompts, card.projectId));
      }
      const current = store.cards.get(card.id) ?? card;
      const planVersion = result.plan ? applyPlan(current, result.plan) : null;
      reply(result.reply, { ready: result.ready, ...(planVersion ? { planVersion } : {}) });
      proposeChanges(store, store.cards.get(card.id) ?? card, result.proposal, PLANNER_AUTHOR);
      moveSession(live.session, "idle");
    } catch (error) {
      if (error instanceof MasterError && error.kind === "unavailable") {
        parked.add(card.id);
        throw error;
      }
      log(`planning turn for ${card.key} failed`, error);
      reply(`规划会话出错：${errorText(error)}。再发一条消息即可重试。`, { error: true });
    }
  }

  // ---------- hand-off ----------

  async function handoff(card: CardView, state: ThreadState): Promise<void> {
    const answers = state.handoffRequests.map((e) => e.id);
    const live = liveOf(card.id);
    const cached = handles.get(card.id);
    const plan = renderPlan(store.plans.list(card.id).at(-1)?.snapshot, presetName);
    let summary: string | null = null;
    // Ask the live planner; a lost session or a bad reply falls back to a deterministic summary.
    if (live && cached?.sessionId === live.id && deps.enabled()) {
      try {
        const current: Live = {
          agent: cached.agent,
          session: live,
          rulesSent: cached.rulesSent,
          rulesHash: cached.rulesHash,
          fresh: false,
        };
        let reply = await ask(current, card, buildHandoffMessage(prompts, card.projectId));
        let parsed = parseReply(reply, HandoffSchema);
        for (let retry = 0; retry < tuning().jsonRepairRetries && !parsed.ok; retry++) {
          reply = await ask(current, card, buildRepairMessage(parsed.error, prompts, card.projectId));
          parsed = parseReply(reply, HandoffSchema);
        }
        if (parsed.ok) summary = parsed.value.summary;
      } catch (error) {
        log(`hand-off summary of ${card.key} fell back to the deterministic one`, error);
      }
    }
    summary ??= fallbackHandoff({
      card,
      plan,
      messages: messagesOf(store.events.list(card.id)),
      prompts,
    });

    const project = store.projects.get(card.projectId);
    let path: string | null = null;
    if (project?.repoPath) {
      path = handoffPath(project.repoPath, card.key);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${summary.trim()}\n`);
      } catch (error) {
        log(`could not write ${path}`, error);
        path = null;
      }
    }
    post(card, { kind: HANDOFF, text: summary, path, answers });
    await archive(card, "handed_off");
  }

  // ---------- driver ----------

  async function processCard(cardId: string): Promise<void> {
    for (let i = 0; i < tuning().maxPlanLoops; i++) {
      const card = store.cards.get(cardId);
      const live = liveOf(cardId);
      if (!card || card.archivedAt) {
        if (live) await archive({ id: cardId }, "card_gone");
        return;
      }
      const state = stateOf(card);
      // `pending` only holds the messages that belong to the planner in this column (see thread.ts):
      // draft/todo always, in_progress/verifying without an online executor or after a failed forward.
      if (state.pending.length > 0 && deps.enabled()) {
        await turn(card, state);
        continue;
      }
      if (card.column !== "draft") {
        // Discussion in todo goes on with the live session: the hand-off already exists.
        if (card.column === "todo" && state.handoff) return;
        // The owner moved the card on: hand over (once per discussion) and close the session.
        if (live) {
          if (!state.handoff || state.discussedAfterHandoff) await handoff(card, state);
          else await archive(card, "handed_off");
        }
        return;
      }
      if (!deps.enabled()) return;
      if (state.handoffRequests.length > 0) await handoff(card, state);
      else return;
    }
  }

  /** Serial per card, parallel across cards. */
  function trigger(cardId: string): Promise<void> {
    const next: Promise<void> = (chains.get(cardId) ?? Promise.resolve())
      .then(() => processCard(cardId))
      .then(() => void parked.delete(cardId))
      .catch((error) => {
        if (!(error instanceof MasterError && error.kind === "unavailable")) {
          log(`planning ${cardId} failed`, error);
        }
      })
      .finally(() => {
        if (chains.get(cardId) === next) chains.delete(cardId);
      });
    chains.set(cardId, next);
    return next;
  }

  /** One poll: new owner chat messages, routing fallbacks and hand-off requests, plus live sessions whose card moved on. */
  async function tick(): Promise<void> {
    const rows = db
      .prepare<{ rid: number; card_id: string }>(
        `SELECT rowid AS rid, card_id FROM card_event
         WHERE rowid > ? AND (
           (type = 'chat' AND author_kind = 'user')
           OR (type = 'chat' AND author_kind = 'system' AND json_extract(body_json, '$.fallback') IS NOT NULL)
           OR (type = 'note' AND author_kind != 'agent' AND json_extract(body_json, '$.kind') = 'handoff_request')
         )
         ORDER BY rowid`,
      )
      .all(cursor);
    const cards = new Set<string>();
    for (const row of rows) {
      cursor = Math.max(cursor, row.rid);
      cards.add(row.card_id);
    }
    for (const s of store.sessions.list({ role: "planner", states: LIVE })) {
      if (s.cardId) cards.add(s.cardId);
    }
    await Promise.all([...cards].map((id) => trigger(id)));
  }

  function arm() {
    stopTimer = clock.setTimeout(() => {
      void tick()
        .catch((error) => log("planning poll failed", error))
        .finally(() => running && arm());
    }, deps.pollIntervalMs ?? 2000);
  }

  return {
    tick,
    trigger,
    /** Resume turns that waited for a daemon handle. */
    resume(): Promise<unknown> {
      return Promise.all([...parked].map((id) => trigger(id)));
    },
    start(): void {
      if (running) return;
      running = true;
      void tick().catch((error) => log("planning poll failed", error));
      arm();
    },
    async stop(): Promise<void> {
      running = false;
      stopTimer?.();
      await Promise.allSettled([...chains.values()]);
    },
    liveOf,
  };
}

export type Planning = ReturnType<typeof createPlanning>;
