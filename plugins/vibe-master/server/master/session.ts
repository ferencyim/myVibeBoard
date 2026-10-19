// The long-lived master Paseo session: create/reuse the agent, ask it questions, switch the
// subscription. The agent is a normal Paseo agent (role=master, VIBE_ROLE=master) recorded in
// agent_session (cardId = null), so the board, the push mechanism and the stats see it like any
// other session. Everything the master must not lose lives on the board and in the memory files,
// which is why a switch simply starts a fresh agent and the queue carries on.

import { mkdirSync } from "node:fs";
import type { MasterSettings, MasterTarget } from "../../shared/rpc";
import type { AgentSession } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { isQuotaError } from "../subscription/quota";
import type { Alerts } from "../subscription/alerts";
import type { MasterStateFile } from "../subscription/state";
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
  /** Static rules (system prompt). */
  rules: string;
  workspace(): string;
  alerts: Alerts;
  log(message: string, error?: unknown): void;
}

/**
 * Permission mode per provider so MCP tool calls do not stall the master. The master works in an
 * empty scratch workspace and its rules forbid touching code.
 */
const MODE_BY_PROVIDER: Record<string, string> = {
  claude: "bypassPermissions",
  codex: "full-access",
};

const LIVE = ["starting", "working", "waiting", "idle", "error"] as const;

export interface MasterSession extends MasterAsk {
  /** The subscription the master runs (or will run) on: manual switch, else settings. */
  currentTarget(): Promise<MasterTarget>;
  /** Provider of the live master, if any. */
  activeProvider(): string | null;
  liveSession(): AgentSession | undefined;
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

  async function retire(session: AgentSession | undefined, outcome: string): Promise<void> {
    if (!session) return;
    moveSession(session, "ended", { outcome });
    try {
      await deps.getPaseo()?.agents.ref(session.agentId).archive();
    } catch (error) {
      deps.log(`could not archive the old master agent ${session.agentId}`, error);
    }
  }

  async function spawn(paseo: MasterPaseo, target: MasterTarget): Promise<AgentSession> {
    const cwd = deps.workspace();
    mkdirSync(cwd, { recursive: true });
    const modeId = MODE_BY_PROVIDER[target.provider];
    const created = await paseo.agents.create({
      cwd,
      title: "Vibe Master",
      labels: { role: "master" },
      env: { VIBE_ROLE: "master" },
      config: {
        provider: providerSpec(target),
        systemPrompt: deps.rules,
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
      agent: { agentId: created.id, sessionId: session.id, target },
    }));
    handle = created;
    rulesSent = target.provider === "claude";
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

    if (handle && live && record?.agentId === handle.id && sameTarget(record.target, target)) {
      return handle;
    }
    if (!handle && live && record?.agentId === live.agentId && sameTarget(record.target, target)) {
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
    const fresh = await spawn(paseo, target);
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
      const message = rulesSent ? prompt : `${deps.rules}\n\n---\n\n${prompt}`;

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
      moveSession(session, "idle");
      return result.lastMessage;
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
      const fresh = await spawn(paseo, target);
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
