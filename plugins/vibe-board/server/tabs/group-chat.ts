import type { PaseoApi } from "@getpaseo/client";
import type {
  PluginBeforeRequests,
  PluginHookAgent,
  PluginLifecycleEvents,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { VibeStore } from "../vibe/db";
import {
  TASK_PHASE_LABELS,
  TASK_TAB_ROLE_LABELS,
  type Task,
  type TaskPhase,
  type TaskTab,
} from "../vibe/contract";
import type { GroupTargets } from "../../shared/task-tabs";
import { parseSections } from "./handoff";
import type { TaskTabs, TaskTabView } from "./service";

/** `@#n` / `＠＃n` (full-width digits too, at most 3 digits) at the start of a message; the
 *  punctuation and spaces after it are dropped. */
const MENTION = /^\s*[@＠]\s*[#＃]\s*([0-9０-９]{1,3})(?![0-9０-９])[\s。，、,.．:：;；!！?？~～\-—]*/;
/** A picked target applies to the next message only; an old pick must not authorize anything. */
const TARGET_TTL_MS = 3 * 60_000;
/** How long a forward waits for the host to confirm it recorded the takeover. */
const HANDOFF_WAIT_MS = 15_000;
/** The same row of the same kind within this window is dropped. */
const REPORT_DEDUPE_MS = 30_000;
/** `append` rows of one kind closer than this are coalesced: the latest lands when the window ends. */
const REPORT_INTERVAL_MS = 3_000;
const CLOSED = new Set(["已关闭", "已归档"]);

export function parseMention(text: string): { number: number; body: string } | null {
  const match = MENTION.exec(text);
  if (!match) return null;
  const digits = match[1]!.replace(/[０-９]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
  );
  return { number: Number(digits), body: text.slice(match[0].length) };
}

/** The first meaningful lines of a reply: code fences, headings markup and the handoff sections
 *  are dropped, long lines are cut. */
export function outputDigest(text: string, maxLines = 3, maxChars = 120): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+•]\s+|\d+[.、)]\s+)/, "").replace(/\*\*/g, "").trim();
    if (!line) continue;
    if (/^(未决问题|下一步)\s*[:：]?$/.test(line)) break;
    lines.push(line.length > maxChars ? line.slice(0, maxChars) + "…" : line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function tabName(tab: Pick<TaskTab, "number" | "role">): string {
  return `#${tab.number} ${TASK_TAB_ROLE_LABELS[tab.role]}`;
}

/** `append` rows are events the user must see (turn results, failures, approvals): always a new
 *  row. `progress` rows are the plugin's own running status (review x/n, phase): the next one of
 *  the same kind replaces it while nothing else happened in #1. */
export type ReportMode = "append" | "progress";
type Handover = Omit<PluginLifecycleEvents["agent.user_prompt_handled"], "agentId" | "messageId">;

/** #1 as the group chat: `@#n` routing, the「发给」target, and progress rows from every tab. */
export function createGroupChat(options: {
  store: VibeStore;
  tabs: TaskTabs;
  getPaseo(): PaseoApi | null;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
  handoffWaitMs?: number;
  reportIntervalMs?: number;
}) {
  const { store, tabs } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  const handoffWaitMs = options.handoffWaitMs ?? HANDOFF_WAIT_MS;
  const reportIntervalMs = options.reportIntervalMs ?? REPORT_INTERVAL_MS;
  /** Picked「发给」target per #1 agent. In memory: a plugin restart falls back to 群主. */
  const targets = new Map<string, { number: number; at: number }>();
  /** The last row per #1, so a newer progress row of the same kind replaces it in place. */
  const lastReport = new Map<string, { key: string; id: string; progress: boolean }>();
  /** Per #1 and kind: the last row written (dedupe), when the last `append` row was written
   *  (coalescing window), and the `append` row waiting for its window. */
  const recent = new Map<string, { text: string; at: number }>();
  const appendedAt = new Map<string, number>();
  const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
  const anchorBusy = new Set<string>();
  const phases = new Map<string, TaskPhase>();
  /** Forwards waiting for the host to record their takeover (`agent.user_prompt_handled`). */
  const handovers = new Map<string, (content: Handover) => void>();
  const forwards = new Set<Promise<void>>();

  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  function anchorTask(workspaceId: string | null, agentId: string): Task | undefined {
    const task = workspaceId ? store.tasks.get(workspaceId) : undefined;
    return task && task.anchorAgentId === agentId ? task : undefined;
  }
  function selfNumber(task: Task): number {
    return task.tabs.find((tab) => tab.agentId === task.anchorAgentId)?.number ?? 1;
  }
  function open(view: TaskTabView): boolean {
    return !CLOSED.has(view.status);
  }
  function label(view: TaskTabView): string {
    return `#${view.number} ${view.roleLabel} · ${view.model}`;
  }
  function currentTarget(agentId: string): { number: number; at: number } | null {
    const picked = targets.get(agentId);
    if (!picked) return null;
    if (now() - picked.at >= TARGET_TTL_MS) {
      targets.delete(agentId);
      return null;
    }
    return picked;
  }

  async function targetsFor(workspaceId: string, agentId: string): Promise<GroupTargets> {
    const task = anchorTask(workspaceId, agentId);
    if (!task) return { main: false, selfNumber: null, selected: null, options: [] };
    const self = selfNumber(task);
    const views = await tabs.tabsFor(task, true);
    return {
      main: true,
      selfNumber: self,
      selected: currentTarget(agentId)?.number ?? null,
      options: views
        .filter((view) => view.number !== self)
        .map((view) => ({ number: view.number, label: label(view), role: view.role, open: open(view) })),
    };
  }
  async function select(workspaceId: string, agentId: string, number: number | null) {
    const task = anchorTask(workspaceId, agentId);
    if (!task) throw new Error("只有任务的主会话可以选择发送对象");
    if (number === null || number === selfNumber(task)) targets.delete(agentId);
    else {
      if (!task.tabs.some((tab) => tab.number === number))
        throw new Error(`任务没有 #${number}`);
      targets.set(agentId, { number, at: now() });
    }
    return targetsFor(workspaceId, agentId);
  }

  function waitHandover(messageId: string): Promise<Handover | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        handovers.delete(messageId);
        resolve(null);
      }, handoffWaitMs);
      handovers.set(messageId, (content) => {
        clearTimeout(timer);
        handovers.delete(messageId);
        resolve(content);
      });
    });
  }

  /** `agent.user_prompt`: a person's message to #1 that names another tab goes to that tab as the
   *  person's own message; #1 does not run. Only decides and queues: the host waits on this hook,
   *  so the forward runs once the host has recorded the takeover. */
  function userPrompt(
    request: PluginBeforeRequests["agent.user_prompt"],
  ): { handled: true; note: string } | undefined {
    const task = anchorTask(request.workspaceId, request.agentId);
    if (!task) return undefined;
    lastReport.delete(request.agentId);
    const mention = parseMention(request.text);
    const picked = currentTarget(request.agentId);
    const number = mention ? mention.number : (picked?.number ?? null);
    if (number === null) return undefined;
    const self = selfNumber(task);
    if (number === self) {
      // `@#1` is addressed to 群主 on purpose; it also uses up a pick.
      targets.delete(request.agentId);
      return undefined;
    }
    const others = task.tabs.filter((tab) => tab.number !== self);
    const tab = others.find((candidate) => candidate.number === number);
    if (!tab) {
      const available = others.map(tabName).join("、");
      return {
        handled: true,
        note: `#${number} 不存在，消息没有转发。可用编号：${available || "（无）"}。用 @#编号 开头直接发给该 tab，不加前缀则交给本 tab。`,
      };
    }
    const body = (mention ? mention.body : request.text).trim();
    if (!body && !request.attachments?.length)
      return { handled: true, note: `@#${number} 后面没有内容，消息没有转发。` };
    const job = forward({
      workspaceId: task.workspaceId,
      anchorId: request.agentId,
      number,
      name: tabName(tab),
      body,
      sessionMode: request.sessionMode,
      // Registered now, before the host can emit the handover.
      handover: waitHandover(request.messageId),
      pickedAt: picked?.at ?? null,
    });
    forwards.add(job);
    void job.finally(() => forwards.delete(job));
    return { handled: true, note: `正在转给 ${tabName(tab)}。` };
  }

  /** The host recorded a takeover: the forward waiting for it gets the original attachments. */
  function userPromptHandled(event: PluginLifecycleEvents["agent.user_prompt_handled"]) {
    const { agentId: _agentId, messageId, ...content } = event;
    handovers.get(messageId)?.(content);
  }

  async function forward(job: {
    workspaceId: string;
    anchorId: string;
    number: number;
    name: string;
    body: string;
    sessionMode: string | undefined;
    handover: Promise<Handover | null>;
    pickedAt: number | null;
  }) {
    try {
      const content = await job.handover;
      // No confirmation: the host let #1 have the message (the hook answered too late).
      if (!content) throw new Error("宿主没有确认接管，这条消息已交给 #1");
      const task = store.tasks.get(job.workspaceId);
      if (!task) throw new Error("任务已不存在");
      const views = await tabs.tabsFor(task, true);
      const target = views.find((view) => view.number === job.number);
      if (!target || !open(target)) throw new Error(`${job.name}${target ? target.status : "不存在"}`);
      const anchor = views.find((view) => view.agentId === job.anchorId);
      // Mode ids belong to a provider: only pass one on to the same kind of agent.
      const modeApplies = !!job.sessionMode && anchor?.provider === target.provider;
      // No sourceAgentId: the tab receives the person's own message, with the same authority as
      // typing it there (e.g. @#4 authorizes execution).
      await paseo()
        .agents.ref(target.agentId)
        .send(job.body || "（见附件）", {
          ...(content.images?.length ? { images: content.images } : {}),
          ...(content.attachments?.length ? { attachments: content.attachments } : {}),
          ...(modeApplies ? { sessionMode: job.sessionMode } : {}),
        });
      // Delivered: the pick this message used is spent. A failed forward keeps it for a resend.
      const picked = targets.get(job.anchorId);
      if (picked && picked.at === job.pickedAt) targets.delete(job.anchorId);
      if (job.sessionMode && !modeApplies)
        await report(
          job.workspaceId,
          "forward",
          `模式切换未随转发生效：${job.name} 与本 tab 不是同一种 agent，需要时请到 #${job.number} 切换模式。`,
        );
    } catch (error) {
      log("转发 #1 消息失败", error);
      const reason = error instanceof Error ? error.message : String(error);
      await report(job.workspaceId, "forward", `转给 ${job.name} 失败：${reason}，请重发。`);
    }
  }

  async function writeRow(anchor: string, key: string, text: string, mode: ReportMode) {
    const slot = anchor + "\0" + key;
    const at = now();
    const last = recent.get(slot);
    if (last && last.text === text && at - last.at < REPORT_DEDUPE_MS) return;
    const previous = lastReport.get(anchor);
    const replace =
      mode === "progress" &&
      previous?.progress &&
      previous.key === key &&
      !anchorBusy.has(anchor) &&
      tabs.lastStatusId(anchor) === previous.id
        ? previous.id
        : undefined;
    recent.set(slot, { text, at });
    if (mode === "append") appendedAt.set(slot, at);
    try {
      const id = await tabs.appendStatus(anchor, text, replace ? { replace } : {});
      if (id) lastReport.set(anchor, { key, id, progress: mode === "progress" });
    } catch (error) {
      log("#1 进展汇报失败", error);
    }
  }

  /** One row in #1. The same text of the same kind within 30 seconds is dropped; `append` rows of
   *  one kind closer than the interval are coalesced so a busy tab cannot flood #1. */
  async function report(workspaceId: string, key: string, text: string, mode: ReportMode = "append") {
    const anchor = store.tasks.get(workspaceId)?.anchorAgentId;
    if (!anchor) return;
    const slot = anchor + "\0" + key;
    if (mode === "append" && reportIntervalMs > 0) {
      const waiting = pending.get(slot);
      if (waiting) {
        waiting.text = text;
        return;
      }
      const last = appendedAt.get(slot);
      const wait = last === undefined ? 0 : last + reportIntervalMs - now();
      if (wait > 0) {
        const timer = setTimeout(() => {
          const queued = pending.get(slot);
          pending.delete(slot);
          if (queued) void writeRow(anchor, key, queued.text, mode);
        }, wait);
          pending.set(slot, { text, timer });
        return;
      }
    }
    await writeRow(anchor, key, text, mode);
  }

  /** #1 talks or runs: later rows must not replace rows above that activity. */
  function anchorTurn(agent: { id: string; workspaceId: string | null }, running: boolean) {
    if (!anchorTask(agent.workspaceId, agent.id)) return;
    lastReport.delete(agent.id);
    if (running) anchorBusy.add(agent.id);
    else anchorBusy.delete(agent.id);
  }

  async function tabTurnEnded(input: {
    task: Task;
    tab: TaskTab;
    outcome: PluginTurnOutcome;
    output: string;
  }) {
    const { task, tab, outcome } = input;
    if (tab.agentId === task.anchorAgentId) return;
    const name = tabName(tab);
    let text: string;
    if (outcome.kind === "failed") {
      text = `${name} 回合失败 · 查看 #${tab.number}${outcome.error.message ? "\n" + outcome.error.message : ""}`;
    } else if (outcome.kind === "canceled") {
      text = `${name} 回合已中止 · 查看 #${tab.number}${outcome.reason ? "\n" + outcome.reason : ""}`;
    } else {
      const lines = outputDigest(input.output);
      const next = parseSections(input.output).nextSteps[0];
      if (next) lines.push("下一步：" + next);
      text = [`${name} 本轮结束 · 查看 #${tab.number}`, ...lines].join("\n");
    }
    await report(task.workspaceId, "turn:" + tab.agentId, text);
  }

  /** A tab (or its sub-agent) waits for the user's approval; #1 points there. */
  async function permissionRequested(agent: PluginHookAgent) {
    const task = agent.workspaceId ? store.tasks.get(agent.workspaceId) : undefined;
    if (!task || agent.id === task.anchorAgentId) return;
    let tab = task.tabs.find((candidate) => candidate.agentId === agent.id);
    let sub = false;
    if (!tab) {
      let parent = agent.parentAgentId;
      for (let depth = 0; parent && !tab && depth < 5; depth++) {
        tab = task.tabs.find((candidate) => candidate.agentId === parent);
        if (tab) break;
        try {
          const handle = paseo().agents.ref(parent);
          await handle.refresh();
          parent = handle.current()?.labels?.[PARENT_AGENT_ID_LABEL] ?? null;
        } catch {
          parent = null;
        }
      }
      sub = true;
    }
    if (!tab) return;
    const who = sub ? `${tabName(tab)} 的子代理${agent.title ? `「${agent.title}」` : ""}` : tabName(tab);
    await report(
      task.workspaceId,
      "perm:" + agent.id,
      `${who}正在等你审批，请去 #${tab.number} 处理`,
    );
  }

  /** `task.updated` from any plugin: report phase changes. */
  async function taskUpdated(workspaceId: string, fields: readonly string[]) {
    if (!fields.includes("phase")) return;
    const task = store.tasks.get(workspaceId);
    if (!task) return;
    const previous = phases.get(workspaceId);
    phases.set(workspaceId, task.phase);
    if (previous === task.phase) return;
    const from = previous ? TASK_PHASE_LABELS[previous] + " → " : "";
    await report(workspaceId, "phase", `任务阶段：${from}${TASK_PHASE_LABELS[task.phase]}`, "progress");
  }

  return {
    userPrompt,
    userPromptHandled,
    targetsFor,
    select,
    report,
    anchorTurn,
    tabTurnEnded,
    permissionRequested,
    taskUpdated,
    /** Waits for queued forwards (tests). */
    async settle() {
      await Promise.all(forwards);
    },
    close() {
      for (const waiting of pending.values()) clearTimeout(waiting.timer);
      pending.clear();
    },
  };
}
export type GroupChat = ReturnType<typeof createGroupChat>;
