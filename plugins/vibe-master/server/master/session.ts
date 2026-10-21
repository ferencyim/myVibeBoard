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
import { composeRules } from "./templates";
import type { AgentSession } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { FOLLOW_SETTINGS, type PermissionResolver, type ResolvedPermission } from "../subscription/permission";
import { isQuotaError } from "../subscription/quota";
import type { Alerts } from "../subscription/alerts";
import type { MasterSessionNote, MasterStateFile } from "../subscription/state";
import {
  providerSpec,
  resolveTarget,
  sameTarget,
  type TargetRequest,
} from "../subscription/target";
import { MasterError, type MasterAgentHandle, type MasterAsk, type MasterPaseo } from "../types";

export interface MasterSessionDeps {
  store: VibeStore;
  getPaseo(): MasterPaseo | null;
  settings(): MasterSettings;
  state: MasterStateFile;
  permission: PermissionResolver;
  /** Static rules (system prompt). */
  rules: string;
  /** Owner supplement appended to the rules (settings); read on every use. */
  supplement?(): string;
  workspace(): string;
  alerts: Alerts;
  log(message: string, error?: unknown): void;
}

const LIVE = ["starting", "working", "waiting", "idle", "error"] as const;

export interface MasterSession extends MasterAsk {
  /** The subscription the master runs (or will run) on: manual switch, else settings. */
  currentTarget(): Promise<MasterTarget>;
  /** Provider of the live master, if any. */
  activeProvider(): string | null;
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
  switchTo(
    request: TargetRequest,
    reason?: string,
  ): Promise<{ target: MasterTarget; changed: boolean; sessionId: string | null }>;
}

export function createMasterSession(deps: MasterSessionDeps): MasterSession {
  const { store } = deps;
  let handle: MasterAgentHandle | null = null;
  /** The rules were delivered in the conversation (providers that ignore systemPrompt need this). */
  let rulesSent = false;
  let settingsTarget: { key: string; value: MasterTarget } | null = null;
  /** Rule supplement the agent has seen (system prompt or conversation). */
  let deliveredSupplement = "";
  /** Hand-off summary for the first message to a freshly started agent. */
  let pendingHandoff: string | null = null;
  const supplement = () => deps.supplement?.() ?? "";
  const rules = () => composeRules(deps.rules, supplement());
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

  async function currentTarget(): Promise<MasterTarget> {
    const switched = deps.state.read().target;
    if (switched) return switched;
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
    const s = deps.settings();
    const key = JSON.stringify([s.provider, s.model, s.thinking]);
    if (settingsTarget?.key === key) return settingsTarget.value;
    const value = await resolveTarget(paseo, {
      provider: s.provider,
      model: s.model || undefined,
      thinking: s.thinking || undefined,
    });
    settingsTarget = { key, value };
    return value;
  }

  const requestedMode = () => deps.state.read().permissionMode ?? deps.settings().permissionMode;

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
    return buildHandoff({ store, nowMs: nowMs(), switches });
  }

  async function spawn(paseo: MasterPaseo, target: MasterTarget, reason: string): Promise<AgentSession> {
    const hadPredecessor = store.sessions.list({ role: "master" }).length > 0;
    const { modeId } = await resolvePermission(target);
    const cwd = deps.workspace();
    mkdirSync(cwd, { recursive: true });
    const created = await paseo.agents.create({
      cwd,
      title: "Vibe Master",
      labels: { role: "master" },
      env: { VIBE_ROLE: "master" },
      config: {
        provider: providerSpec(target),
        systemPrompt: rules(),
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
      agent: { agentId: created.id, sessionId: session.id, target, modeId },
    }));
    note(session.id, { provider: target.provider, model: target.model, thinking: target.thinking });
    handle = created;
    rulesSent = target.provider === "claude";
    deliveredSupplement = supplement();
    pendingHandoff = hadPredecessor ? handoffFor(reason) : null;
    deps.log(`master agent ${created.id} started on ${providerSpec(target)}`);
    return session;
  }

  /** The agent for the wanted subscription: reuse the live one or start a fresh one. */
  async function ensure(): Promise<MasterAgentHandle> {
    const paseo = deps.getPaseo();
    if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
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
      const alive = await candidate.refresh().then(
        (r) => r != null,
        () => false,
      );
      if (alive) {
        handle = candidate;
        rulesSent = true;
        return candidate;
      }
    }
    const fresh = await spawn(paseo, target, "replaced");
    if (live && live.id !== fresh.id) await retire(live, "replaced");
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
      const fresh = await spawn(paseo, target, "mode_changed");
      await retire(live, "mode_changed");
      return { changed: true, sessionId: fresh.id };
    },

    async ask(prompt, options = {}) {
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
      const sup = supplement();
      const parts: string[] = [];
      if (!rulesSent) parts.push(rules());
      else if (sup !== deliveredSupplement) {
        parts.push(
          sup.trim()
            ? `[Owner rule supplement updated - it replaces any earlier supplement]\n${sup.trim()}`
            : "[Owner rule supplement removed - ignore any earlier supplement]",
        );
      }
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
        result = await agent.run(message, { timeoutMs: options.timeoutMs ?? 5 * 60_000 });
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
      deliveredSupplement = sup;
      if (pendingHandoff === handoff) pendingHandoff = null;
      moveSession(session, "idle");
      return result.lastMessage;
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

    async switchTo(request, reason) {
      const paseo = deps.getPaseo();
      if (!paseo) throw new MasterError("unavailable", "No daemon handle yet");
      const target = await resolveTarget(paseo, request);
      const record = deps.state.read().agent;
      const live = liveSession();
      if (live && record?.agentId === live.agentId && sameTarget(record.target, target)) {
        deps.state.update((s) => ({ ...s, target }));
        return { target, changed: false, sessionId: live.id };
      }
      // Start the new agent first: if the provider is unavailable the old one keeps working.
      const fresh = await spawn(paseo, target, reason ?? "switch");
      deps.state.update((s) => ({ ...s, target }));
      if (live && live.id !== fresh.id) {
        if (live.currentProvider !== target.provider) {
          try {
            store.sessions.switchProvider(live.id, target.provider, reason);
          } catch (error) {
            deps.log("could not record the provider switch", error);
          }
        }
        await retire(live, "switched");
      }
      return { target, changed: true, sessionId: fresh.id };
    },
  };
}
