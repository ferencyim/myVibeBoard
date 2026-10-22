// Per-card planning sessions (WP-33, reworked by WP-105). The plan tab of a card is a conversation
// with a planning agent that runs on the card's **planning model** (a preset the owner picks), in
// the project repository in read-only mode. The 制定方案 button (a plan-thread owner message with
// action "make_plan") first runs a scout on the card's **scout model** when one is picked, then asks
// the planner for a plan. The planner may ask the owner questions; the owner answers or gives
// change requests in the same thread. Its plan overwrites the card's only plan (cards.setPlan) and
// its acceptance criteria go to the card, or become a proposal when the owner edited them.
//
// The master agent takes no part (WP-105). Switching the planning model archives the old session;
// the new one starts with the card's plan conversation, plan and criteria (nothing is lost: all of
// it lives on the card).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseReply } from "../assess/parse";
import { proposeChanges } from "../assess/proposal";
import type { Clock } from "../clock";
import { buildProjectBlock } from "../master/prompts";
import { reviveAgent } from "../master/revive";
import type { MemoryPort } from "../memory/files";
import { defaultPromptPort, hashText, type PromptPort } from "../prompts/port";
import { defaultTuning, type TuningSource } from "../tuning";
import type { Alerts } from "../subscription/alerts";
import { isQuotaError } from "../subscription/quota";
import { providerSpec, resolveTarget } from "../subscription/target";
import { MasterError, type MasterAgentHandle, type MasterPaseo } from "../types";
import type { AgentSession, CardView, PlanSnapshot, Preset, Project } from "../vibe/contract";
import type { VibeDb, VibeStore } from "../vibe/db";
import {
  buildRepairMessage,
  buildResultsMessage,
  buildScoutMessage,
  buildStartMessage,
  buildTurnMessage,
  exploreQuestion,
  renderResearch,
  type ResearchItem,
} from "./prompts";
import { PlanTurnSchema, type PlanTurn } from "./schema";
import { PLANNER_AUTHOR, messagesOf, threadState, type ThreadState } from "./thread";

const LIVE = ["starting", "working", "waiting", "idle", "error"] as const;
/** Read-only mode of the known providers; any other provider is looked up in its mode catalog. */
const READ_ONLY_MODE: Record<string, string> = { claude: "plan", codex: "read-only" };
const READ_ONLY_PATTERN = /^(plan|read[-_ ]?only)$/i;

export async function readOnlyModeOf(paseo: MasterPaseo, provider: string): Promise<string | undefined> {
  const known = READ_ONLY_MODE[provider];
  if (known) return known;
  try {
    const res = await paseo.providers.listModes?.(provider);
    return res?.modes?.find((m) => READ_ONLY_PATTERN.test(m.id) || READ_ONLY_PATTERN.test(m.label))?.id;
  } catch {
    return undefined; // the provider's default mode
  }
}

interface Target {
  provider: string;
  model: string;
  thinking: string | null;
}

/** Provider/model/thinking of a preset; an empty model is resolved from the provider catalog. */
async function targetOf(paseo: MasterPaseo, preset: Preset): Promise<Target> {
  const thinking = preset.thinking && preset.thinking !== "default" ? preset.thinking : null;
  if (preset.model) return { provider: preset.provider, model: preset.model, thinking };
  const resolved = await resolveTarget(paseo, { provider: preset.provider });
  return { ...resolved, thinking };
}

export interface PlanningDeps {
  db: VibeDb;
  store: VibeStore;
  getPaseo(): MasterPaseo | null;
  /** Prompt texts (registry); defaults when omitted. */
  prompts?: PromptPort;
  /** Automation parameters (settings); defaults when omitted. */
  tuning?: TuningSource;
  /** Max characters of the requirements document in the project block (settings). */
  requirementsChars?(): number;
  /** `<VIBE_HOME>/master`; cwd of planners whose project has no repository path. */
  dataDir: string;
  clock: Clock;
  memory: MemoryPort;
  alerts?: Alerts;
  enabled(): boolean;
  pollIntervalMs?: number;
  log?: (message: string, error?: unknown) => void;
}

interface Live {
  agent: MasterAgentHandle;
  session: AgentSession;
  presetId: string;
  /** The system prompt was delivered (as system prompt or in the first message). */
  systemSent: boolean;
  systemHash: string;
  fresh: boolean;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_PLANNER = "还没有选择规划模型：请先在方案页顶部选一个规划模型，再点「制定方案」或重新发送。";

export function createPlanning(deps: PlanningDeps) {
  const { store, db, clock } = deps;
  const log = deps.log ?? (() => undefined);
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.tuning ?? defaultTuning;
  const handles = new Map<string, Omit<Live, "session" | "fresh"> & { sessionId: string }>();
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

  const presetOf = (id: string | null) => (id ? (store.presets.get(id) ?? null) : null);
  const systemText = (projectId: string) => prompts.resolve("master.plan.system", { projectId });
  const tagNames = (card: CardView) => {
    const all = store.tags.list();
    return card.tags.map((id) => all.find((t) => t.id === id)?.name).filter((n): n is string => !!n);
  };

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

  function cwdOf(card: CardView, project: Project | undefined): string {
    if (project?.repoPath) return project.repoPath;
    const dir = join(deps.dataDir, "planning", card.key);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---------- agent lifecycle ----------

  async function spawn(card: CardView, preset: Preset): Promise<Live> {
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
    const target = await targetOf(paseo, preset);
    const modeId = await readOnlyModeOf(paseo, target.provider);
    const system = systemText(card.projectId);
    const created = await paseo.agents.create({
      cwd: cwdOf(card, store.projects.get(card.projectId)),
      title: `方案 ${card.key} · ${card.title}`.slice(0, 80),
      labels: { role: "planner", card: card.key, preset: preset.name },
      env: { VIBE_ROLE: "planner", VIBE_CARD_ID: card.id, VIBE_CARD_KEY: card.key },
      config: {
        provider: providerSpec(target),
        systemPrompt: system,
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
    const live: Live = {
      agent: created,
      session,
      presetId: preset.id,
      systemSent: target.provider === "claude",
      systemHash: hashText(system),
      fresh: true,
    };
    handles.set(card.id, { ...live, sessionId: session.id });
    log(`planner ${created.id} for ${card.key} started on ${providerSpec(target)}`);
    return live;
  }

  /** The planner of this card on the card's planning model: the live one, or a fresh one. */
  async function ensure(card: CardView, preset: Preset): Promise<Live> {
    const live = liveOf(card.id);
    const cached = handles.get(card.id);
    if (live && cached && cached.sessionId === live.id) {
      if (cached.presetId === preset.id) return { ...cached, session: live, fresh: false };
      // The owner picked another planning model: the new session starts from what the card holds.
      log(`planner for ${card.key}: planning model changed, restarting on ${preset.name}`);
      await archive(card, "model_changed");
      return spawn(card, preset);
    }
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
    if (live) {
      // After a restart nothing records the preset: keep the agent while the provider matches.
      const candidate = paseo.agents.ref(live.agentId);
      if (live.currentProvider === preset.provider && (await reviveAgent(candidate))) {
        const entry = {
          agent: candidate,
          sessionId: live.id,
          presetId: preset.id,
          systemSent: true,
          systemHash: hashText(systemText(card.projectId)),
        };
        handles.set(card.id, entry);
        return { ...entry, session: live, fresh: false };
      }
      await archive(card, live.currentProvider === preset.provider ? "lost" : "model_changed");
    }
    return spawn(card, preset);
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

  async function ask(live: Live, card: Pick<CardView, "id" | "projectId">, prompt: string): Promise<string> {
    moveSession(live.session, "working");
    const system = systemText(card.projectId);
    const hash = hashText(system);
    const message = !live.systemSent
      ? `${system}\n\n---\n\n${prompt}`
      : hash !== live.systemHash
        ? `${prompts.resolve("master.rules_updated", { projectId: card.projectId, vars: { rules: system } })}\n\n---\n\n${prompt}`
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
    live.systemSent = true;
    live.systemHash = hash;
    const cached = handles.get(card.id);
    if (cached) {
      cached.systemSent = true;
      cached.systemHash = hash;
    }
    return result.lastMessage;
  }

  /** Parse a reply; repair rounds (settings), then the raw text is the reply (the owner still gets an answer). */
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

  // ---------- scouts (the card's scout model) ----------

  async function research(
    card: CardView,
    project: Project | undefined,
    requests: readonly { question: string; scope?: string }[],
  ): Promise<ResearchItem[]> {
    const preset = presetOf(card.scoutPresetId);
    const paseo = deps.getPaseo();
    const why = !preset
      ? "这张卡片没有选择探路模型，请自己阅读代码"
      : !project?.repoPath
        ? "项目没有设置仓库路径"
        : !paseo
          ? "还没有连上守护进程"
          : null;
    if (why || !preset || !paseo || !project) return requests.map((r) => ({ ...r, ok: false, answer: why ?? "" }));
    return Promise.all(
      requests.map(async (r): Promise<ResearchItem> => {
        let agent: MasterAgentHandle | null = null;
        try {
          const target = await targetOf(paseo, preset);
          const modeId = await readOnlyModeOf(paseo, target.provider);
          agent = await paseo.agents.create({
            cwd: project.repoPath,
            title: `探路 ${card.key}`,
            labels: { role: "scout", card: card.key, preset: preset.name },
            env: { VIBE_ROLE: "scout", VIBE_CARD_KEY: card.key },
            config: {
              provider: providerSpec(target),
              ...(target.thinking ? { thinkingOptionId: target.thinking } : {}),
              ...(modeId ? { modeId } : {}),
            },
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

  function postScout(card: CardView, items: ResearchItem[], key: string): void {
    store.cards.addChat({
      cardId: card.id,
      authorKind: "scout",
      author: presetOf(card.scoutPresetId)?.name ?? "scout",
      kind: "summary",
      thread: "plan",
      text: renderResearch(items),
      key,
    });
  }

  // ---------- write-back ----------

  /** Overwrite the card's plan and criteria; returns a line for the reply when the criteria became a proposal. */
  function apply(card: CardView, result: PlanTurn): string {
    const acceptance = result.acceptance?.trim() || undefined;
    if (!result.plan && !acceptance) return "";
    const plan: PlanSnapshot | undefined = result.plan
      ? {
          description: result.plan.text,
          checks: [],
          subCards: [],
          tags: [],
          recommendedPresetId: null,
          ...(result.plan.files.length ? { files: result.plan.files } : {}),
        }
      : undefined;
    const saved = store.cards.setPlan(card.id, { plan, acceptance, author: PLANNER_AUTHOR });
    return saved.acceptance === "proposed"
      ? "\n\n（你改过验收标准，这次的修改作为建议放在下面，采纳后才会写入。）"
      : "";
  }

  // ---------- one conversation turn ----------

  async function turn(card: CardView, state: ThreadState): Promise<void> {
    const pending = state.pending;
    const answers = pending.map((m) => m.id);
    const key = `reply:${answers.join("+")}`;
    let live: Live | undefined;
    const reply = (text: string, extra: { error?: boolean } = {}) =>
      store.cards.addChat({
        cardId: card.id,
        authorKind: "master",
        author: PLANNER_AUTHOR,
        thread: "plan",
        text,
        answers,
        key,
        ...(live ? { agentId: live.agent.id, sessionId: live.session.id } : {}),
        ...extra,
      });
    const preset = presetOf(card.plannerPresetId);
    if (!preset) {
      reply(NO_PLANNER, { error: true });
      return;
    }
    const project = store.projects.get(card.projectId);
    try {
      live = await ensure(card, preset);
      const makePlan = pending.some((m) => m.makePlan);
      let findings = "";
      if (makePlan && card.scoutPresetId) {
        const items = await research(card, project, [{ question: exploreQuestion(card, prompts) }]);
        postScout(card, items, `explore:${answers[0]}`);
        findings = renderResearch(items);
      }
      const events = store.events.list(card.id);
      const prompt =
        live.fresh || makePlan
          ? buildStartMessage({
              projectBlock: project
                ? buildProjectBlock({
                    project,
                    tags: store.tags.list(),
                    presets: store.presets.list(),
                    openCards: store.cards
                      .list({ projectId: card.projectId })
                      .filter((c) => c.id !== card.id && c.column !== "done"),
                    requirementsChars: deps.requirementsChars?.(),
                    cardLimit: tuning().projectBlockCardLimit,
                  })
                : "",
              memory: project ? memoryText(project) : "",
              card: store.cards.get(card.id) ?? card,
              tagNames: tagNames(card),
              earlier: messagesOf(events).filter((m) => !answers.includes(m.id)),
              pending,
              findings,
              prompts,
            })
          : buildTurnMessage(pending, prompts, card.projectId);
      let result = await askTurn(live, card, prompt);
      for (let round = 0; round < tuning().maxResearchRounds && result.research.length > 0; round++) {
        const items = await research(card, project, result.research);
        postScout(card, items, `research:${answers[0]}:${round + 1}`);
        result = await askTurn(live, card, buildResultsMessage(items, prompts, card.projectId));
      }
      const current = store.cards.get(card.id) ?? card;
      const note = apply(current, result);
      reply(`${result.reply}${note}`);
      proposeChanges(store, store.cards.get(card.id) ?? card, result.proposal ?? undefined, PLANNER_AUTHOR);
      moveSession(live.session, "idle");
    } catch (error) {
      if (error instanceof MasterError && error.kind === "unavailable") {
        parked.add(card.id);
        throw error;
      }
      log(`planning turn for ${card.key} failed`, error);
      reply(`规划会话出错：${errorText(error)}。再发一条消息或重新点「制定方案」即可重试。`, { error: true });
    }
  }

  // ---------- driver ----------

  async function processCard(cardId: string): Promise<void> {
    for (let i = 0; i < tuning().maxPlanLoops; i++) {
      const card = store.cards.get(cardId);
      if (!card || card.archivedAt || card.column === "done") {
        if (liveOf(cardId)) await archive({ id: cardId }, card?.column === "done" ? "card_done" : "card_gone");
        return;
      }
      const state = threadState(store.events.list(card.id));
      if (state.pending.length === 0 || !deps.enabled()) return;
      await turn(card, state);
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

  /** One poll: new owner chat messages, plus live sessions whose card finished or disappeared. */
  async function tick(): Promise<void> {
    const rows = db
      .prepare<{ rid: number; card_id: string }>(
        `SELECT rowid AS rid, card_id FROM card_event
         WHERE rowid > ? AND type = 'chat' AND author_kind = 'user'
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
