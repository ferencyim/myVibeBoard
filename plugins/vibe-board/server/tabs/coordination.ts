import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  PLAN_STATUS_LABELS,
  TASK_TAB_ROLE_LABELS,
  findOverlap,
  planFiles,
  taskPlanStatus,
  type PlanStatus,
  type Task,
  type TaskTab,
} from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { reviewActive } from "./plan-review";
import { SCOUT_ASK_PROMPT } from "./prompts";
import type { TaskTabs } from "./service";

// Round 8 (WP-130): the shared scout and cross-task plan awareness.

export interface ProjectPlanView {
  workspaceId: string;
  name: string | null;
  status: PlanStatus;
  statusLabel: string;
  goal: string | null;
  files: string[];
  updatedAt: string | null;
  /** First pair (this task's file, the other task's file) that overlap, or null. */
  overlap: [string, string] | null;
  /** Absolute paths outside the task's worktree: scope unknown, left out of the overlap check. */
  unknownFiles?: string[];
}

const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]/;
const slashes = (path: string) => path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
/** Plan files relative to the task's worktree root. An absolute path under the root becomes
 *  relative; one outside it (or with no known root) has an unknown scope. */
export function scopeFiles(
  files: readonly string[],
  root: string | null,
): { files: string[]; unknown: string[] } {
  const base = root ? slashes(root).toLowerCase() : null;
  const out: string[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    if (!ABSOLUTE.test(file.trim())) {
      out.push(file);
      continue;
    }
    const path = slashes(file);
    const lower = path.toLowerCase();
    if (base && lower === base) out.push("**");
    else if (base && lower.startsWith(base + "/")) out.push(path.slice(base.length + 1));
    else unknown.push(file);
  }
  return { files: [...new Set(out)], unknown };
}
/** A failed project lookup is retried after this long. */
const UNRESOLVED_TTL_MS = 60_000;
/** The panel polls; a slow name lookup shows the workspace id instead of holding the list. */
const NAME_WAIT_MS = 1_500;

/** Plans still in play: a finished or abandoned task no longer competes for files. */
const ACTIVE: ReadonlySet<PlanStatus> = new Set([
  "draft",
  "awaiting_confirmation",
  "executing",
  "checking",
  "awaiting_acceptance",
  "paused",
]);

export function createCoordination(options: {
  store: VibeStore;
  tabs: TaskTabs;
  getPaseo(): PaseoApi | null;
  log?: (message: string, error?: unknown) => void;
}) {
  const { store, tabs } = options;
  const log = options.log ?? ((message, error) => console.error("[vibe-board]", message, error ?? ""));
  /** Workspaces whose native project could not be read, with when; retried after a minute. */
  const unresolved = new Map<string, number>();
  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  async function agentOf(agentId: string): Promise<PaseoAgent | undefined> {
    try {
      const handle = paseo().agents.ref(agentId);
      await handle.refresh();
      return handle.current() ?? undefined;
    } catch {
      return undefined;
    }
  }
  /** The caller's task and the task tab it speaks for: its own, or its parent tab's. */
  async function callerTab(agentId: string): Promise<{ task: Task; tab: TaskTab }> {
    let agent = await agentOf(agentId);
    if (!agent?.workspaceId) throw new Error("当前 agent 不属于任务 workspace");
    const task = store.tasks.get(agent.workspaceId);
    if (!task) throw new Error("当前 workspace 不是 Vibe 任务");
    for (let depth = 0; agent && depth < 5; depth++) {
      const tab = task.tabs.find((candidate) => candidate.agentId === agent!.id);
      if (tab) return { task, tab };
      const parent: string | undefined = agent.labels?.[PARENT_AGENT_ID_LABEL];
      agent = parent ? await agentOf(parent) : undefined;
    }
    throw new Error("vibe_ask_scout、vibe_project_plans 只能由任务 tab 或其子代理调用");
  }

  /** vibe_ask_scout: hand a question to the task's scout tab with the asker's number. */
  async function askScout(callerAgentId: string, input: { question: string }) {
    const { task, tab } = await callerTab(callerAgentId);
    const scout = [...task.tabs].reverse().find((candidate) => candidate.role === "scout");
    if (!scout)
      throw new Error(
        "本任务没有启用探路 tab（项目或全局默认里探路为「不启用」）。请自己调查，或请用户在项目设置里启用探路后再提问。",
      );
    if (scout.agentId === callerAgentId) throw new Error("探路 tab 不能向自己提问");
    const agent = await agentOf(scout.agentId);
    if (!agent || agent.archivedAt || agent.status === "closed")
      throw new Error(`探路 tab #${scout.number} 已关闭或归档，无法接收问题`);
    const from = `#${tab.number} ${TASK_TAB_ROLE_LABELS[tab.role]}${tab.agentId === callerAgentId ? "" : ` 的子代理`}（agentId: ${callerAgentId}）`;
    const placement = await tabs.workspace(task.workspaceId).catch(() => undefined);
    const prompt = store.prompts.resolve(SCOUT_ASK_PROMPT.key, {
      projectId: placement?.projectId ?? null,
      vars: { from, question: input.question.trim() },
    });
    await paseo().agents.ref(scout.agentId).send(prompt, { sourceAgentId: callerAgentId });
    return {
      scout: { number: scout.number, agentId: scout.agentId },
      message: `已把问题交给 #${scout.number} 探路；它完成后会用 send_agent_prompt 把结论发回给你。`,
    };
  }

  /** The native project of a task: recorded in control, otherwise read once from its workspace. */
  async function projectOf(task: Task): Promise<string | null> {
    const recorded = task.control?.projectId;
    if (typeof recorded === "string" && recorded) return recorded;
    const failedAt = unresolved.get(task.workspaceId);
    if (failedAt !== undefined && Date.now() - failedAt < UNRESOLVED_TTL_MS) return null;
    try {
      const handle = paseo().workspaces.ref(task.workspaceId);
      await handle.refresh();
      const workspace = handle.current();
      const projectId = handle.projectId ?? workspace?.projectId ?? null;
      if (!projectId) throw new Error("workspace 没有项目");
      store.tasks.updateControl(task.workspaceId, {
        projectId,
        ...(workspace?.archivingAt ? { archivedAt: workspace.archivingAt } : {}),
      });
      unresolved.delete(task.workspaceId);
      return projectId;
    } catch {
      unresolved.set(task.workspaceId, Date.now());
      return null;
    }
  }
  /** Workspace names for display; the panel polls, so names are cached for a minute. */
  const names = new Map<string, { name: string | null; at: number }>();
  async function nameOf(workspaceId: string): Promise<string | null> {
    const cached = names.get(workspaceId);
    if (cached && Date.now() - cached.at < 60_000) return cached.name;
    const lookup = (async () => {
      let name: string | null = null;
      try {
        const handle = paseo().workspaces.ref(workspaceId);
        await handle.refresh();
        name = handle.current()?.name ?? handle.name ?? null;
      } catch {
        name = null;
      }
      names.set(workspaceId, { name, at: Date.now() });
      return name;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string | null>((resolve) => {
      timer = setTimeout(() => resolve(cached?.name ?? null), NAME_WAIT_MS);
    });
    try {
      return await Promise.race([lookup, late]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Files relative to the task's worktree; the root is read only when a path is absolute. */
  async function scoped(workspaceId: string, files: readonly string[]) {
    if (!files.some((file) => ABSOLUTE.test(file.trim()))) return { files: [...files], unknown: [] };
    const root = await tabs
      .workspace(workspaceId)
      .then((placement) => placement.directory ?? null)
      .catch(() => null);
    return scopeFiles(files, root);
  }
  /** This task's files: explicit candidates, the draft under review, or its saved plan. */
  function ownFiles(task: Task, files?: readonly string[]): string[] {
    if (files?.length) return [...files];
    const draft = reviewActive(task)?.draftPlan;
    return planFiles(draft ?? task.plan);
  }

  /** Other tasks of the same native project with their derived plan status; overlapping active
   *  plans first, then the most recently updated. */
  async function projectPlans(workspaceId: string, files?: readonly string[]) {
    const task = store.tasks.get(workspaceId);
    if (!task) throw new Error("当前 workspace 不是 Vibe 任务");
    const projectId = await projectOf(task);
    if (!projectId) throw new Error("无法确定当前任务所属的项目");
    const mine = await scoped(workspaceId, ownFiles(task, files));
    const all = store.tasks.list().filter((other) => other.workspaceId !== workspaceId);
    const projects = await Promise.all(all.map((other) => projectOf(other)));
    const others: ProjectPlanView[] = await Promise.all(
      all
        .filter((_, index) => projects[index] === projectId)
        .map(async (other) => {
          const status = taskPlanStatus(other, !!other.control?.archivedAt);
          // A draft under multi-model review is not saved as the plan yet; its files still count.
          const theirs = await scoped(
            other.workspaceId,
            planFiles(reviewActive(other)?.draftPlan ?? other.plan),
          );
          return {
            workspaceId: other.workspaceId,
            name: null,
            status,
            statusLabel: PLAN_STATUS_LABELS[status],
            goal: reviewActive(other)?.goal ?? other.plan?.goal ?? null,
            files: theirs.files,
            updatedAt: other.updatedAt ?? other.confirmedAt ?? null,
            overlap: findOverlap(mine.files, theirs.files),
            ...(theirs.unknown.length ? { unknownFiles: theirs.unknown } : {}),
          };
        }),
    );
    const rank = (view: ProjectPlanView) =>
      view.overlap && ACTIVE.has(view.status) ? 0 : ACTIVE.has(view.status) ? 1 : 2;
    others.sort(
      (a, b) => rank(a) - rank(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    // Names only for the rows shown, looked up in parallel.
    const plans = others.slice(0, 50);
    await Promise.all(
      plans.map(async (plan) => {
        plan.name = await nameOf(plan.workspaceId);
      }),
    );
    return { projectId, files: mine.files, unknownFiles: mine.unknown, plans };
  }

  /** vibe_project_plans for an agent: its task's project, with a one-line overlap verdict. */
  async function projectPlansFor(callerAgentId: string, input: { files?: string[] }) {
    const { task } = await callerTab(callerAgentId);
    const result = await projectPlans(task.workspaceId, input.files);
    const overlapping = result.plans.filter((plan) => plan.overlap && ACTIVE.has(plan.status));
    const unknown = result.unknownFiles.length
      ? `以下文件不在本任务 worktree 内，范围未知，未参与重叠检查：${result.unknownFiles.join("、")}。`
      : "";
    return {
      ...result,
      message: (!result.files.length
        ? "本任务还没有方案文件；写方案时传入 files 参数可检查重叠。"
        : overlapping.length
          ? `有 ${overlapping.length} 个进行中的方案与本任务文件重叠：` +
            overlapping
              .map(
                (plan) =>
                  `「${plan.goal ?? "尚无方案"}」（${plan.name ?? plan.workspaceId}，${plan.statusLabel}，${plan.overlap![0]} ↔ ${plan.overlap![1]}）`,
              )
              .join("；") +
            "。请在方案里写明如何避让，或排在其后。"
          : "没有与本任务文件重叠的进行中方案。") + unknown,
    };
  }

  /** The flow panel section; never throws (the panel must still render). */
  async function panelPlans(workspaceId: string): Promise<ProjectPlanView[]> {
    try {
      return (await projectPlans(workspaceId)).plans;
    } catch (error) {
      log("同项目方案读取失败", error);
      return [];
    }
  }

  /** workspace.archived: the plan list keeps such tasks as abandoned. */
  function markArchived(workspaceId: string) {
    if (!store.tasks.get(workspaceId)) return;
    store.tasks.updateControl(workspaceId, { archivedAt: new Date().toISOString() });
  }

  return { askScout, projectPlans, projectPlansFor, panelPlans, markArchived };
}
export type Coordination = ReturnType<typeof createCoordination>;
