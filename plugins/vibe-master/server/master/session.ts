// The long-lived master Paseo session: create/reuse the agent, ask it questions, switch the
// subscription. The agent is a normal Paseo agent (role=master, VIBE_ROLE=master) recorded in
// agent_session (cardId = null), so the board, the push mechanism and the stats see it like any
// other session. Everything the master must not lose lives on the board and in the memory files,
// which is why a switch simply starts a fresh agent and the queue carries on. A replaced agent is
// NOT archived (the owner can still open its conversation); the new one gets a board-derived
// hand-off summary with its first message.

import { mkdirSync } from "node:fs";
import type { MasterSessionRow, MasterSettings, MasterTarget } from "../../shared/rpc";
import { buildHandoff, type SwitchNote } from "./handoff";
import { reviveAgent } from "./revive";
import { hashText, rulesUpdateMessage, type PromptPort } from "../prompts/port";
import { defaultTuning, type TuningSource } from "../tuning";
import { isModelUnavailableError, presetModels, withPresetModel, type AgentSession } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { FOLLOW_SETTINGS, type PermissionResolver, type ResolvedPermission } from "../subscription/permission";
import { isQuotaError } from "../subscription/quota";
import type { Alerts } from "../subscription/alerts";
import type { MasterSessionNote, MasterStateFile } from "../subscription/state";
import { resolveMasterPreset, targetOfPreset } from "../subscription/preset";
import { providerSpec, sameTarget } from "../subscription/target";
import { MasterError, type MasterAgentHandle, type MasterAsk, type MasterPaseo } from "../types";

export interface MasterSessionDeps {
  store: VibeStore;
  getPaseo(): MasterPaseo | null;
  settings(): MasterSettings;
  state: MasterStateFile;
  permission: PermissionResolver;
  /** The system prompt in effect (rules body + supplement from the prompt registry); read on every use. */
  rules(): string;
  /** Wording of the "rules updated" notice. */
  prompts: PromptPort;
  tuning?: TuningSource;
  workspace(): string;
  alerts: Alerts;
  log(message: string, error?: unknown): void;
}

const LIVE = ["starting", "working", "waiting", "idle", "error"] as const;

export interface MasterSession extends MasterAsk {
  /** The provider/model/thinking of the preset chosen in the settings (throws "unavailable" without one). */
  currentTarget(): Promise<MasterTarget>;
  /** Provider of the live master, if any. */
  activeProvider(): string | null;
  failover(reason: string): Promise<boolean>;
  liveSession(): AgentSession | undefined;
  /** The permission mode the master runs (or will run) with, and where the choice comes from. */
  permission(): Promise<{ setting: string; source: "settings" | "switched"; resolved: ResolvedPermission }>;
  /**
   * Manual permission switch (`FOLLOW_SETTINGS` = back to the settings default). A running master
   * is replaced by a fresh agent in the new mode (the Paseo plugin API has no in-place mode change).
   */
  setPermission(mode: string): Promise<{ changed: boolean; sessionId: string | null }>;
  /** Every master session, newest first (the current one flagged). */
  sessions(limit?: number): MasterSessionRow[];
  /**
   * The chosen preset changed: a running master is replaced by a fresh agent on the new one (the
   * old conversation stays openable, the new agent gets the hand-off summary). Without a running
   * master nothing happens; the next question starts it on the current preset.
   */
  applyPreset(reason?: string): Promise<{ changed: boolean; sessionId: string | null }>;
}

export function createMasterSession(deps: MasterSessionDeps): MasterSession {
  const { store } = deps;
  let handle: MasterAgentHandle | null = null;
  /** The rules were delivered in the conversation (providers that ignore systemPrompt need this). */
  let rulesSent = false;
  let presetTarget: { key: string; value: MasterTarget } | null = null;
  /** Hash of the rules text the agent has seen (system prompt or conversation). */
  let deliveredRules = "";
  /** Hand-off summary for the first message to a freshly started agent. */
  let pendingHandoff: string | null = null;
  const tuning = deps.tuning ?? defaultTuning;
  const nowMs = () => Date.now();
  const note = (sessionId: string, patch: Partial<MasterSessionNote>) =>
    deps.state.update((d) => ({
      ...d,
      sessions: {
        ...d.sessions,
        [sessionId]: { model: "", thinking: null, ...d.sessions?.[sessionId], ...patch },
      },
    }));

  const liveSession = () => store.sessions.list({ role: "master", states: LIVE }).at(-1);

  function moveSession(
    session: AgentSession | undefined,
    to: AgentSession["state"],
    opts: { message?: string; outcome?: string } = {},
  ) {
    if (!session) return;
    try {
      const current = store.sessions.get(session.id);
      if (current && current.state !== to) store.sessions.setState(session.id, to, opts);
    } catch (error) {
      deps.log(`master session state ${to} rejected`, error);
    }
  }

  function selection() {
    const { preset } = resolveMasterPreset(deps.settings(), store.presets.list());
    if (!preset) throw new MasterError("unavailable", "没有为总 agent 选择预设（请在总 agent 设置页选择）");
    const models = presetModels(preset);
    const key = JSON.stringify([preset.id, models]);
    let progress = deps.state.read().presetSelection;
    if (progress?.key !== key) {
      progress = { key, index: 0 };
      deps.state.update((s) => ({ ...s, presetSelection: progress }));
    }
    return { preset, models, progress };
  }

  async function currentTarget(): Promise<MasterTarget> {
    const { preset, models, progress } = selection();
    const key = JSON.stringify([progress.key, progress.index]);
    if (presetTarget?.key === key) return presetTarget.value;
    // A preset with a model needs no catalog; an empty model is resolved through the daemon.
    const value = await targetOfPreset(deps.getPaseo(), withPresetModel(preset, models[progress.index]!));
    presetTarget = { key, value };
    return value;
  }

  const requestedMode = () => {
    const { models, progress } = selection();
    const mode = deps.state.read().permissionMode ?? deps.settings().permissionMode;
    return mode === "preset" ? models[progress.index]!.permissionMode : mode;
  };

  function advance(reason: string): boolean {
    const { models, progress } = selection();
    const next = progress.index + 1;
    if (next >= models.length) {
      deps.state.update((s) => ({ ...s, presetSelection: { ...progress, exhausted: true } }));
      return false;
    }
    deps.log(`总 agent 自动切换到预设候选 ${next + 1}: ${reason}`);
    deps.state.update((s) => ({ ...s, presetSelection: { key: progress.key, index: next } }));
    return true;
  }

  async function failover(reason: string): Promise<boolean> {
    const paseo = deps.getPaseo();
    if (!paseo || selection().progress.exhausted) return false;
    const previous = liveSession();
    while (advance(reason)) {
      try {
        const target = await currentTarget();
        const fresh = await spawn(paseo, target, reason);
        if (previous && previous.id !== fresh.id) {
          if (previous.currentProvider !== target.provider) store.sessions.switchProvider(previous.id, target.provider, reason);
          await retire(previous, reason);
        }
        return true;
      } catch (error) {
        if (!isModelUnavailableError(error) && !isQuotaError(error instanceof Error ? error.message : String(error))) throw error;
        deps.log("总 agent 候选启动失败", error);
      }
    }
    deps.alerts.raise("provider_error", "master", `总 agent 预设内所有模型均不可用，已停止自动切换。${reason}`);
    return false;
  }

  async function resolvePermission(target: MasterTarget): Promise<ResolvedPermission> {
    return deps.permission.resolve(target.provider, requestedMode());
  }

  /**
   * The old agent keeps its conversation and stays openable; only the board session ends. It is
   * renamed so the owner can tell it from the live master (skipped on hosts without `setTitle`).
   */
  async function retire(session: AgentSession | undefined, outcome: string): Promise<void> {
    if (!session) return;
    moveSession(session, "ended", { outcome });
    note(session.id, { retiredReason: outcome, retiredAt: new Date(nowMs()).toISOString() });
    const day = new Date(nowMs()).toISOString().slice(0, 10);
    try {
      await deps.getPaseo()?.agents.ref(session.agentId).setTitle?.(`Vibe Master（已退役 ${day}）`);
    } catch (error) {
      deps.log(`could not rename the retired master agent ${session.agentId}`, error);
    }
  }

  function handoffFor(reason: string): string {
    const history = store.sessions.list({ role: "master" });
    const switches: SwitchNote[] = history.flatMap((h) =>
      h.switchHistory.map((e) => ({ at: e.at, text: `${e.from} -> ${e.to}${e.reason ? `: ${e.reason}` : ""}` })),
    );
    const retired = Object.values(deps.state.read().sessions ?? {})
      .filter((n) => n.retiredAt && n.retiredReason)
      .map((n) => ({ at: n.retiredAt!, text: `旧会话结束: ${n.retiredReason}` }));
    switches.push(...retired, { at: new Date(nowMs()).toISOString(), text: `本次更换原因: ${reason}` });
    switches.sort((a, b) => a.at.localeCompare(b.at));
    return buildHandoff({
      store,
      nowMs: nowMs(),
      switches,
      prompts: deps.prompts,
      maxChars: tuning().handoffMaxChars,
      recentDays: tuning().handoffRecentDays,
    });
  }

  async function spawn(paseo: MasterPaseo, target: MasterTarget, reason: string): Promise<AgentSession> {
    const hadPredecessor = store.sessions.list({ role: "master" }).length > 0;
    const { modeId } = await resolvePermission(target);
    const cwd = deps.workspace();
    mkdirSync(cwd, { recursive: true });
    const systemPrompt = deps.rules();
    const created = await paseo.agents.create({
      cwd,
      title: "Vibe Master",
      labels: { role: "master" },
      env: { VIBE_ROLE: "master" },
      config: {
        provider: providerSpec(target),
        systemPrompt,
        ...(target.thinking ? { thinkingOptionId: target.thinking } : {}),
        ...(modeId ? { modeId } : {}),
      },
    });
    const session = store.sessions.start({
      cardId: null,
      agentId: created.id,
      role: "master",
      provider: target.provider,
    });
    deps.state.update((s) => ({
      ...s,
      agent: { agentId: created.id, sessionId: session.id, target, modeId, rulesHash: hashText(systemPrompt) },
    }));
    note(session.id, { provider: target.provider, model: target.model, thinking: target.thinking });
    handle = created;
    rulesSent = target.provider === "claude";
    deliveredRules = hashText(systemPrompt);
    pendingHandoff = hadPredecessor ? handoffFor(reason) : null;
    deps.log(`master agent ${created.id} started on ${providerSpec(target)}`);
    return session;
  }

  /** The agent for the wanted subscription: reuse the live one or start a fresh one. */
  async function ensure(): Promise<MasterAgentHandle> {
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
    if (selection().progress.exhausted) throw new MasterError("unavailable", "总 agent 预设内所有模型均不可用，请更换预设或调整候选列表");
    const target = await currentTarget();
    const record = deps.state.read().agent;
    const live = liveSession();
    const { modeId } = await resolvePermission(target);
    const current = (r: typeof record) => !!r && sameTarget(r.target, target) && (r.modeId ?? null) === modeId;

    if (handle && live && record?.agentId === handle.id && current(record)) {
      return handle;
    }
    if (!handle && live && record?.agentId === live.agentId && current(record)) {
      const candidate = paseo.agents.ref(record.agentId);
      if (await reviveAgent(candidate)) {
        handle = candidate;
        rulesSent = true;
        // Records from before the hash was kept: assume the agent has the current rules.
        deliveredRules = record.rulesHash ?? hashText(deps.rules());
        return candidate;
      }
    }
    // The recorded agent is still the wanted one but could not be brought back: say so in the hand-off.
    const unrecoverable = !!live && record?.agentId === live.agentId && current(record);
    const reason = unrecoverable ? "restart_recovery_failed" : "replaced";
    const fresh = await spawn(paseo, target, reason);
    if (live && live.id !== fresh.id) await retire(live, reason);
    return handle!;
  }

  const classify = (message: string): MasterError =>
    new MasterError(isQuotaError(message) ? "quota" : "agent", message);

  async function providerLabel(): Promise<string> {
    try {
      return (await currentTarget()).provider;
    } catch {
      return "unknown";
    }
  }

  return {
    currentTarget,
    failover,
    liveSession,
    activeProvider: () => liveSession()?.currentProvider ?? null,

    async permission() {
      const override = deps.state.read().permissionMode;
      const resolved = await resolvePermission(await currentTarget());
      return {
        setting: override ?? deps.settings().permissionMode,
        source: override ? "switched" : "settings",
        resolved,
      };
    },

    async setPermission(mode) {
      deps.state.update((s) => {
        const { permissionMode: _drop, ...rest } = s;
        return mode === FOLLOW_SETTINGS ? rest : { ...rest, permissionMode: mode };
      });
      const live = liveSession();
      const record = deps.state.read().agent;
      if (!live || record?.agentId !== live.agentId) return { changed: false, sessionId: live?.id ?? null };
      const paseo = deps.getPaseo();
      if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
      const target = await currentTarget();
      const { modeId } = await resolvePermission(target);
      if (sameTarget(record.target, target) && (record.modeId ?? null) === modeId) {
        return { changed: false, sessionId: live.id };
      }
      // Start the new agent first: if it cannot start, the old one keeps working.
      let fresh: AgentSession;
      try {
        fresh = await spawn(paseo, target, "mode_changed");
      } catch (error) {
        if (!isModelUnavailableError(error) && !isQuotaError(error instanceof Error ? error.message : String(error))) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!(await failover(message))) throw new MasterError("unavailable", `总 agent 预设内所有模型均不可用：${message}`);
        return { changed: true, sessionId: liveSession()!.id };
      }
      await retire(live, "mode_changed");
      return { changed: true, sessionId: fresh.id };
    },

    async ask(prompt, options = {}) {
      const askOnce = async (): Promise<string> => {
      let agent: MasterAgentHandle;
      try {
        agent = await ensure();
      } catch (error) {
        if (error instanceof MasterError) throw error;
        const failure = classify(error instanceof Error ? error.message : String(error));
        if (failure.kind === "quota") {
          deps.alerts.raise("quota_error", await providerLabel(), failure.message);
        }
        throw failure;
      }
      const session = liveSession();
      moveSession(session, "working");
      const rulesText = deps.rules();
      const rulesHash = hashText(rulesText);
      const parts: string[] = [];
      if (!rulesSent) parts.push(rulesText);
      else if (rulesHash !== deliveredRules) parts.push(rulesUpdateMessage(deps.prompts, rulesText));
      const handoff = pendingHandoff;
      if (handoff) parts.push(handoff);
      parts.push(prompt);
      const message = parts.join("\n\n---\n\n");

      const fail = (failure: MasterError): never => {
        moveSession(session, "error", { message: failure.message });
        if (failure.kind === "quota") {
          deps.alerts.raise("quota_error", session?.currentProvider ?? "unknown", failure.message);
        }
        throw failure;
      };

      let result;
      try {
        result = await agent.run(message, { timeoutMs: options.timeoutMs ?? tuning().askTimeoutMs });
      } catch (error) {
        return fail(classify(error instanceof Error ? error.message : String(error)));
      }
      if (result.status === "error") {
        return fail(classify(result.error ?? "The master agent failed without a message"));
      }
      if (result.status === "permission") {
        return fail(new MasterError("permission", "The master agent is waiting for a permission"));
      }
      if (result.status === "timeout") {
        return fail(new MasterError("timeout", "The master agent did not answer in time"));
      }
      if (!result.lastMessage?.trim()) {
        return fail(new MasterError("agent", "The master agent returned an empty reply"));
      }
      rulesSent = true;
      deliveredRules = rulesHash;
      deps.state.update((s) => (s.agent ? { ...s, agent: { ...s.agent, rulesHash } } : s));
      if (pendingHandoff === handoff) pendingHandoff = null;
      moveSession(session, "idle");
      return result.lastMessage;
      };
      while (true) {
        try {
          return await askOnce();
        } catch (error) {
          if (!deps.getPaseo()) throw error;
          const failure = error instanceof MasterError ? error : classify(error instanceof Error ? error.message : String(error));
          if (failure.kind === "permission" || failure.kind === "timeout" || (!isModelUnavailableError(failure) && failure.kind !== "quota")) throw failure;
          if (selection().progress.exhausted) throw failure;
          if (!(await failover(failure.message))) throw new MasterError(failure.kind, `总 agent 预设内所有模型均不可用：${failure.message}`);
        }
      }
    },

    sessions(limit = 30) {
      const notes = deps.state.read().sessions ?? {};
      const liveId = liveSession()?.id;
      return store.sessions
        .list({ role: "master" })
        .reverse()
        .slice(0, limit)
        .map((x) => ({
          sessionId: x.id,
          agentId: x.agentId,
          provider: notes[x.id]?.provider ?? x.currentProvider,
          model: notes[x.id]?.model ?? "",
          thinking: notes[x.id]?.thinking ?? null,
          state: x.state,
          startedAt: x.startedAt,
          endedAt: x.endedAt,
          current: x.id === liveId,
          retiredReason: notes[x.id]?.retiredReason ?? null,
        }));
    },

    async applyPreset(reason) {
      if (selection().progress.exhausted) return { changed: false, sessionId: liveSession()?.id ?? null };
      const live = liveSession();
      if (!live) return { changed: false, sessionId: null };
      const paseo = deps.getPaseo();
      if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
      const target = await currentTarget();
      const record = deps.state.read().agent;
      const { modeId } = await resolvePermission(target);
      if (record?.agentId === live.agentId && sameTarget(record.target, target) && (record.modeId ?? null) === modeId) {
        return { changed: false, sessionId: live.id };
      }
      // Start the new agent first: if the provider is unavailable the old one keeps working.
      let fresh: AgentSession;
      try {
        fresh = await spawn(paseo, target, reason ?? "switch");
      } catch (error) {
        if (!isModelUnavailableError(error) && !isQuotaError(error instanceof Error ? error.message : String(error))) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!(await failover(message))) throw new MasterError("unavailable", `总 agent 预设内所有模型均不可用：${message}`);
        return { changed: true, sessionId: liveSession()!.id };
      }
      if (live.id !== fresh.id) {
        if (live.currentProvider !== target.provider) {
          try {
            store.sessions.switchProvider(live.id, target.provider, reason);
          } catch (error) {
            deps.log("could not record the provider switch", error);
          }
        }
        await retire(live, "switched");
      }
      return { changed: true, sessionId: fresh.id };
    },
  };
}
