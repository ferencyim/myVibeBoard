import type {
  PluginButton,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { groupSelectRpc, groupTargetsRpc, type GroupTargets } from "../shared/task-tabs";

/** Task tabs are titled「#n 角色 · 模型」; only a `#1` title can be a task's main tab. */
const MAIN_TITLE = /^#1\s/;
const REFRESH_DELAY_MS = 1_500;
/** While a tab is picked, re-check now and then: the daemon clears the pick after a delivered
 *  message or when it expires, and neither changes an agent the client watches. */
const PICKED_REFRESH_MS = 5_000;
/** Lucide shield-alert in a fixed warning red: sending to the execution tab authorizes execution. */
const AUTHORIZES_ICON = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e5484d" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
};

interface AgentLike {
  id: string;
  workspaceId?: string | null;
  title?: string | null;
  archivedAt?: string | null;
}

function picked(targets: GroupTargets) {
  return targets.options.find((option) => option.number === targets.selected);
}
/** 「将发给 #2 方案」. For the execution tab the label leads with the authorization instead: pill
 *  labels get about ten characters before they are cut. */
export function targetLabel(targets: GroupTargets): string {
  const option = picked(targets);
  if (!option) return "将发给 群主";
  const name = option.label.split(" · ")[0];
  return option.role === "worker" ? `发送即授权 ${name}` : `将发给 ${name}`;
}

/**「发给」composer pill on each task's #1: picks the tab the next message goes to (as if it
 *  started with `@#n`). The pick lives on the daemon, which clears it once a message reached that
 *  tab and keeps it when the forward failed. */
export function contributeGroupTarget(client: PluginClientContext): () => void {
  const pills = new Map<
    string,
    { registration: PluginButtonRegistration; workspaceId: string; shown: string }
  >();
  /** Agents already checked and found not to be a main tab, by title. */
  const notMain = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lifetime = new AbortController();
  let stopped = false;

  function button(workspaceId: string, agentId: string, targets: GroupTargets): PluginButton {
    const select = (number: number | null) => async () => {
      apply(agentId, workspaceId, await client.rpc(groupSelectRpc, { workspaceId, agentId, number }));
    };
    const items: PluginButtonMenuEntry[] = [
      {
        kind: "item",
        id: "main",
        title: `群主（#${targets.selfNumber ?? 1}）`,
        icon: targets.selected === null ? "Check" : "Users",
        behavior: { kind: "action", onPress: select(null) },
      },
      { kind: "separator", id: "tabs-divider" },
      ...targets.options.map(
        (option): PluginButtonMenuEntry => ({
          kind: "item",
          id: "tab-" + option.number,
          title: option.open ? option.label : `${option.label}（已关闭）`,
          icon:
            targets.selected === option.number
              ? "Check"
              : option.role === "worker"
                ? "ShieldAlert"
                : "MessageSquare",
          disabled: !option.open,
          behavior: { kind: "action", onPress: select(option.number) },
        }),
      ),
    ];
    return {
      title: picked(targets)?.role === "worker" ? "发给：发送即授权执行" : "发给",
      icon: picked(targets)?.role === "worker" ? AUTHORIZES_ICON : "Send",
      label: targetLabel(targets),
      behavior: { kind: "menu", items },
    };
  }
  function apply(agentId: string, workspaceId: string, targets: GroupTargets) {
    if (stopped) return;
    const existing = pills.get(agentId);
    if (!targets.main) {
      existing?.registration.remove();
      pills.delete(agentId);
      return;
    }
    if (targets.selected !== null) schedule({ id: agentId, workspaceId }, PICKED_REFRESH_MS);
    // Updating the behavior closes an open menu, so only a real change republishes it.
    const shown = JSON.stringify(targets);
    if (existing?.shown === shown) return;
    const next = button(workspaceId, agentId, targets);
    if (existing) {
      existing.shown = shown;
      existing.registration.update(next);
      return;
    }
    pills.set(agentId, {
      workspaceId,
      shown,
      registration: client.addComposerPill({ id: "group-target", workspaceId, agentId, button: next }),
    });
  }
  async function check(agent: AgentLike) {
    const workspaceId = agent.workspaceId;
    if (!workspaceId) return;
    try {
      const targets = await client.rpc(groupTargetsRpc, { workspaceId, agentId: agent.id });
      if (!targets.main) notMain.set(agent.id, agent.title ?? "");
      apply(agent.id, workspaceId, targets);
    } catch (error) {
      if (!stopped) console.error("[vibe-board] 发给选择器刷新失败", error);
    }
  }
  function schedule(agent: AgentLike, delay = REFRESH_DELAY_MS) {
    clearTimeout(timers.get(agent.id));
    timers.set(
      agent.id,
      setTimeout(() => {
        timers.delete(agent.id);
        void check(agent);
      }, delay),
    );
  }
  function remove(agentId: string) {
    clearTimeout(timers.get(agentId));
    timers.delete(agentId);
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
    notMain.delete(agentId);
  }
  function observe(agent: AgentLike, immediate = false) {
    const candidate =
      !!agent.workspaceId &&
      !agent.archivedAt &&
      MAIN_TITLE.test(agent.title ?? "");
    if (candidate && notMain.get(agent.id) !== (agent.title ?? "")) {
      if (immediate) void check(agent);
      else schedule(agent);
    }
    else if (!candidate && pills.has(agent.id)) remove(agent.id);
    // A change in another tab of a task (title, status) refreshes that task's picker.
    for (const [mainId, pill] of pills)
      if (mainId !== agent.id && pill.workspaceId === agent.workspaceId)
        schedule({ id: mainId, workspaceId: pill.workspaceId });
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) observe(agent, true);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else observe(update.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) console.error("[vibe-board] 发给选择器无法订阅 agent 列表", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
