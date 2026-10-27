import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import {
  taskRoleModeId,
  type Task,
  type TaskPlan,
  type TaskPlanSource,
  type TaskTab,
} from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { PLAN_REVIEW_REQUEST_PROMPT, PLAN_REVIEW_REVISE_PROMPT } from "./prompts";
import { PLAN_REVIEW_LABEL, resolvePlannerPresets, type TaskTabs } from "./service";

// 方案 tab multi-model review (WP-130). The plugin, not the model, runs the cycle: the writer's
// draft goes to each reviewer in list order (sub-agents of the 方案 tab, never top tabs); each sees
// the draft and every earlier opinion. When all are done the writer gets the opinions and its next
// plan is final. Only the first complete plan of a confirmation round is reviewed automatically;
// the user asks for another pass with /重新审阅.

export interface ReviewerModel {
  provider: string;
  model: string;
  thinking?: string;
}
export interface PlanReviewer extends ReviewerModel {
  index: number;
  presetId: string;
  /** Every model of the reviewer's preset in order; a failed start or run moves to the next. */
  candidates?: ReviewerModel[];
  attempt?: number;
  agentId: string | null;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  startedAt?: string;
}
export interface PlanReviewState {
  cycle: string;
  status: "reviewing" | "revising" | "done" | "cancelled";
  plannerAgentId: string;
  plannerTab: number;
  draftKey: string;
  /** plan_review artifact holding the draft text the reviewers read. */
  draftArtifact?: string;
  goal: string;
  draftPlan: TaskPlan;
  reviewers: PlanReviewer[];
  startedAt: string;
  finishedAt?: string;
  note?: string;
  /** confirmedAt of the round the cycle belongs to; one automatic cycle per round. */
  round?: string | null;
  /** Started by the user's /重新审阅. */
  manual?: boolean;
  /** When the revise request reached the writer; unset means it still has to be sent. */
  reviseSentAt?: string;
  reviseError?: string;
  /** The writer's plan that closed the cycle (a revision nobody reviewed again). */
  finalPlan?: TaskPlan;
}

/** Each opinion and the draft are kept as plan_review artifacts under this source prefix. */
const keyOf = (cycle: string, part: number | string) => `review:${cycle}:${part}`;
const MAX_TEXT = 30_000;
/** An idle reviewer gets this long after its start before "idle without output" counts. */
const IDLE_GRACE_MS = 60_000;
export const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60_000;
const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? text.slice(0, max) + "\n…（已截断）" : text;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function reviewState(task: Pick<Task, "control"> | undefined): PlanReviewState | undefined {
  const value = task?.control?.planReview;
  return value && typeof value === "object" ? (value as PlanReviewState) : undefined;
}
export function reviewActive(task: Pick<Task, "control"> | undefined): PlanReviewState | undefined {
  const state = reviewState(task);
  return state && (state.status === "reviewing" || state.status === "revising") ? state : undefined;
}
const STATUS_LABELS: Record<PlanReviewer["status"], string> = {
  pending: "等待",
  running: "审阅中",
  done: "已完成",
  failed: "失败",
};

export function createPlanReview(options: {
  store: VibeStore;
  tabs: TaskTabs;
  getPaseo(): PaseoApi | null;
  /** The latest assistant text of one turn of an agent (null: its latest turn). */
  turnOutput(agentId: string, turnId: string | null): Promise<string>;
  projectId(workspaceId: string): Promise<string | null>;
  log(message: string, error?: unknown): void;
  /** A progress row in the task's #1 (merged with the previous review row there). */
  report(workspaceId: string, key: string, text: string, mode?: "append" | "progress"): Promise<void>;
  /** Per-reviewer timeout (the owner setting); defaults to 20 minutes. */
  timeoutMs?: () => number;
  now?: () => number;
}) {
  const { store, tabs, log } = options;
  const now = options.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  function paseo(): PaseoApi {
    const api = options.getPaseo();
    if (!api) throw new Error("任务宿主尚未连接");
    return api;
  }
  function save(workspaceId: string, state: PlanReviewState) {
    store.tasks.updateControl(workspaceId, { planReview: state });
  }
  function current(workspaceId: string, cycle: string): PlanReviewState | undefined {
    const state = reviewState(store.tasks.get(workspaceId));
    return state?.cycle === cycle ? state : undefined;
  }
  /** Re-reads the stored state (never an earlier snapshot) and saves `change` applied to it. */
  function update(
    workspaceId: string,
    cycle: string,
    change: (state: PlanReviewState) => PlanReviewState,
  ): PlanReviewState | undefined {
    const state = current(workspaceId, cycle);
    if (!state) return undefined;
    const next = change(state);
    save(workspaceId, next);
    return next;
  }
  function withReviewer(
    state: PlanReviewState,
    index: number,
    patch: (reviewer: PlanReviewer) => PlanReviewer,
  ): PlanReviewState {
    return {
      ...state,
      reviewers: state.reviewers.map((item) => (item.index === index ? patch(item) : item)),
    };
  }
  function opinion(workspaceId: string, cycle: string, index: number): string | undefined {
    const text = store.taskArtifacts.get(workspaceId, "plan_review", keyOf(cycle, index))?.data?.text;
    return typeof text === "string" ? text : undefined;
  }
  function label(reviewer: PlanReviewer, total: number) {
    return `第 ${reviewer.index + 1}/${total} 位审阅者（${reviewer.provider}/${reviewer.model}）`;
  }
  function opinions(workspaceId: string, state: PlanReviewState, upTo: number): string {
    return state.reviewers
      .filter((reviewer) => reviewer.index < upTo)
      .map((reviewer) => {
        const head = `### ${label(reviewer, state.reviewers.length)}`;
        if (reviewer.status === "done")
          return `${head}\n${clip(opinion(workspaceId, state.cycle, reviewer.index) ?? "", 12_000)}`;
        return `${head}\n（审阅失败：${reviewer.error ?? "未知原因"}，没有意见）`;
      })
      .join("\n\n");
  }
  async function status(agentIds: Array<string | undefined>, text: string) {
    for (const agentId of new Set(agentIds.filter((id): id is string => !!id)))
      await tabs.appendStatus(agentId, text).catch((error) => log("方案审阅状态追加失败", error));
  }
  /** Review events are new rows in #1; `progress` (reviewer x of n done) replaces the last one. */
  async function toMain(workspaceId: string, text: string, mode: "append" | "progress" = "append") {
    await options.report(workspaceId, "review", text, mode);
  }
  function savePlan(workspaceId: string, plan: TaskPlan): boolean {
    const task = store.tasks.get(workspaceId);
    if (!task || !["planning", "awaiting_confirmation"].includes(task.phase)) return false;
    if (JSON.stringify(task.plan) !== JSON.stringify(plan)) store.tasks.savePlan(workspaceId, plan);
    return true;
  }
  async function archive(agentId: string | null) {
    if (!agentId) return;
    await paseo()
      .agents.ref(agentId)
      .archive()
      .catch((error) => log("归档方案审阅者失败", error));
  }
  /** Reviewers that still exist once the cycle ends (failed ones were archived when they failed). */
  async function archiveReviewers(state: PlanReviewState) {
    for (const reviewer of state.reviewers)
      if (reviewer.status === "done" || reviewer.status === "running")
        await archive(reviewer.agentId);
  }
  function recordDraft(
    workspaceId: string,
    cycle: string,
    part: string,
    input: { plan: TaskPlan; text: string; source: TaskPlanSource },
  ) {
    const key = keyOf(cycle, part);
    store.taskArtifacts.record({
      workspaceId,
      kind: "plan_review",
      sourceKey: key,
      confirmedAt: null,
      source: { ...input.source, sourceKey: key },
      summary: "方案稿：" + input.plan.goal,
      data: { cycle, part, text: clip(input.text), plan: input.plan },
    });
    return key;
  }

  /** The reviewer list for a task: every model after the writer, each with its preset's
   *  candidate models. */
  async function reviewersFor(task: Task): Promise<PlanReviewer[]> {
    let presets: ReturnType<typeof resolvePlannerPresets> = [];
    try {
      presets = resolvePlannerPresets(store, {
        selections: task.roleSelections,
        projectId: await options.projectId(task.workspaceId),
      });
    } catch (error) {
      log("方案模型列表不可用，跳过审阅", error);
    }
    return presets
      .slice(1)
      .map((preset) => ({
        presetId: preset.presetId,
        candidates: preset.models.map((model) => ({
          provider: model.provider,
          model: model.model,
          ...(model.thinking && model.thinking !== "default" ? { thinking: model.thinking } : {}),
        })),
      }))
      .filter((entry) => entry.candidates.length > 0)
      .map((entry, index) => ({
        index,
        presetId: entry.presetId,
        ...entry.candidates[0]!,
        candidates: entry.candidates,
        attempt: 0,
        agentId: null,
        status: "pending" as const,
      }));
  }

  /** A completed 方案 turn produced a complete plan: finish a revising cycle, feed a running one,
   *  start the round's one automatic cycle, or save it directly. Runs in the flow's queue. */
  async function onPlannerPlan(
    task: Task,
    tab: TaskTab,
    input: { plan: TaskPlan; text: string; source: TaskPlanSource },
  ) {
    const workspaceId = task.workspaceId;
    if (!["planning", "awaiting_confirmation"].includes(task.phase)) return;
    const state = reviewState(task);
    if (state?.status === "revising" && state.plannerAgentId === tab.agentId) {
      savePlan(workspaceId, input.plan);
      const done = state.reviewers.filter((reviewer) => reviewer.status === "done").length;
      const finished = update(workspaceId, state.cycle, (latest) => ({
        ...latest,
        status: "done",
        finishedAt: iso(),
        finalPlan: input.plan,
      }));
      if (finished) await archiveReviewers(finished);
      const text = `#${tab.number} 方案已定稿（经 ${done} 位审阅者审阅，修订稿未再审阅）：${input.plan.goal}。请确认：发送 /执行、在任务流程面板点「执行」，或直接在执行 tab 发消息。`;
      store.tasks.setSummary(workspaceId, text);
      await status([tab.agentId], text);
      await toMain(workspaceId, text);
      return;
    }
    if (state?.status === "reviewing") {
      if (state.draftKey === input.source.sourceKey) return;
      // A newer draft while reviewers run: the cycle keeps going, later reviewers read the new one.
      const draftArtifact = recordDraft(workspaceId, state.cycle, "draft:" + randomUUID(), input);
      update(workspaceId, state.cycle, (latest) => ({
        ...latest,
        draftKey: input.source.sourceKey,
        draftArtifact,
        goal: input.plan.goal,
        draftPlan: input.plan,
      }));
      await status([tab.agentId], `审阅进行中，已改用 #${tab.number} 的新稿；后续审阅者会读到新稿。`);
      return;
    }
    // One automatic cycle per round: later plans (small edits too) are saved without review.
    if (state && (state.round ?? null) === (task.confirmedAt ?? null)) {
      if (JSON.stringify(task.plan) === JSON.stringify(input.plan)) return;
      if (savePlan(workspaceId, input.plan))
        store.tasks.setSummary(
          workspaceId,
          `#${tab.number} 方案已更新（未再审阅，需要时发送 /重新审阅）：${input.plan.goal}`,
        );
      return;
    }
    const reviewers = await reviewersFor(task);
    if (!reviewers.length) {
      if (savePlan(workspaceId, input.plan))
        store.tasks.setSummary(workspaceId, `#${tab.number} 方案已更新：${input.plan.goal}`);
      return;
    }
    await begin(task, tab, input, reviewers, false);
  }

  /** /重新审阅: review the latest plan of the 方案 tab again, ending any unfinished cycle. */
  async function restart(
    task: Task,
    tab: TaskTab,
    input: { plan: TaskPlan; text: string; source: TaskPlanSource },
  ) {
    if (!["planning", "awaiting_confirmation"].includes(task.phase))
      throw new Error("只有规划或待确认阶段可以重新审阅方案");
    const reviewers = await reviewersFor(task);
    if (!reviewers.length)
      throw new Error("方案模型列表只有 1 个模型，没有审阅者；请先在项目或全局默认里添加审阅模型");
    const active = reviewActive(task);
    if (active) await cancelNow(task.workspaceId, active, "用户要求重新审阅");
    return begin(store.tasks.get(task.workspaceId) ?? task, tab, input, reviewers, true);
  }

  async function begin(
    task: Task,
    tab: TaskTab,
    input: { plan: TaskPlan; text: string; source: TaskPlanSource },
    reviewers: PlanReviewer[],
    manual: boolean,
  ) {
    const workspaceId = task.workspaceId;
    const cycle = randomUUID();
    const draftArtifact = recordDraft(workspaceId, cycle, "draft", input);
    save(workspaceId, {
      cycle,
      status: "reviewing",
      plannerAgentId: tab.agentId,
      plannerTab: tab.number,
      draftKey: input.source.sourceKey,
      draftArtifact,
      goal: input.plan.goal,
      draftPlan: input.plan,
      reviewers,
      startedAt: iso(),
      round: task.confirmedAt ?? null,
      ...(manual ? { manual: true } : {}),
    });
    const text = `#${tab.number} 方案${manual ? "按用户要求重新" : "初稿已完成，开始多模型"}审阅（共 ${reviewers.length} 位）：${input.plan.goal}`;
    store.tasks.setSummary(workspaceId, text);
    await status([tab.agentId], text);
    await toMain(workspaceId, text);
    await advance(workspaceId, cycle);
    return { cycle, reviewers: reviewers.length, message: text };
  }

  /** Starts the next pending reviewer, or finishes the cycle once nobody is pending or running. */
  async function advance(workspaceId: string, cycle: string) {
    // Each pass either starts a reviewer or fails one candidate for good; the bound is a backstop.
    for (let guard = 0; guard < 100; guard++) {
      const state = current(workspaceId, cycle);
      if (!state || state.status !== "reviewing") return;
      if (state.reviewers.some((reviewer) => reviewer.status === "running")) return;
      const next = state.reviewers.find((reviewer) => reviewer.status === "pending");
      if (!next) return finish(workspaceId, cycle);
      if (await launch(workspaceId, cycle, next.index)) return;
    }
  }

  /** Opens one reviewer and sends it the request; false when it could not start. */
  async function launch(workspaceId: string, cycle: string, index: number): Promise<boolean> {
    const state = current(workspaceId, cycle);
    const reviewer = state?.reviewers[index];
    if (!state || !reviewer) return false;
    const total = state.reviewers.length;
    let agentId: string | null = null;
    try {
      const modeId = taskRoleModeId("reviewer", reviewer.provider, "auto");
      const handle = await paseo()
        .workspaces.ref(workspaceId)
        .agents.create({
          config: {
            provider: `${reviewer.provider}/${reviewer.model}`,
            ...(modeId ? { modeId } : {}),
            ...(reviewer.thinking ? { thinkingOptionId: reviewer.thinking } : {}),
          },
          parent: state.plannerAgentId,
          title: `#${state.plannerTab} 方案审阅 ${index + 1}/${total}`,
          env: { VIBE_ROLE: "plan_reviewer", VIBE_WORKSPACE_ID: workspaceId },
          labels: { [PLAN_REVIEW_LABEL]: cycle },
        });
      agentId = handle.id;
      const started = update(workspaceId, cycle, (latest) =>
        withReviewer(latest, index, (item) => ({
          ...item,
          agentId: handle.id,
          status: "running",
          startedAt: iso(),
        })),
      );
      if (!started) {
        await archive(handle.id);
        return true;
      }
      const draft = store.taskArtifacts.get(
        workspaceId,
        "plan_review",
        started.draftArtifact ?? keyOf(cycle, "draft"),
      );
      const prompt = store.prompts.resolve(PLAN_REVIEW_REQUEST_PROMPT.key, {
        projectId: await options.projectId(workspaceId),
        vars: {
          planner: `#${started.plannerTab} 方案`,
          position: `${index + 1}/${total}`,
          draft: String(draft?.data?.text ?? JSON.stringify(started.draftPlan, null, 2)),
          reviews: index === 0 ? "（你是第一位审阅者）" : opinions(workspaceId, started, index),
        },
      });
      await handle.send(prompt, { sourceAgentId: started.plannerAgentId });
      await status([started.plannerAgentId], `${label(reviewer, total)}开始审阅。`);
      return true;
    } catch (error) {
      log("方案审阅者启动失败", error);
      await fail(workspaceId, cycle, index, "启动失败：" + reasonOf(error), { retry: true, agentId });
      return false;
    }
  }

  /** One reviewer failed: archive its agent, then try the preset's next model or give up on it.
   *  The caller advances the cycle. */
  async function fail(
    workspaceId: string,
    cycle: string,
    index: number,
    reason: string,
    input: { retry: boolean; agentId?: string | null },
  ) {
    const state = current(workspaceId, cycle);
    const reviewer = state?.reviewers[index];
    if (!state || !reviewer || state.status !== "reviewing") return;
    await archive(input.agentId ?? reviewer.agentId);
    const total = state.reviewers.length;
    const candidates = reviewer.candidates ?? [];
    const attempt = (reviewer.attempt ?? 0) + 1;
    const next = input.retry ? candidates[attempt] : undefined;
    const history = [reviewer.error, `${reviewer.provider}/${reviewer.model}：${reason}`]
      .filter(Boolean)
      .join("；");
    update(workspaceId, cycle, (latest) =>
      withReviewer(latest, index, (item) => {
        const { startedAt: _startedAt, thinking: _thinking, ...rest } = item;
        return next
          ? { ...rest, ...next, attempt, agentId: null, status: "pending", error: history }
          : { ...item, agentId: input.agentId ?? item.agentId, status: "failed", error: history };
      }),
    );
    await status(
      [state.plannerAgentId],
      next
        ? `${label(reviewer, total)}${reason}；换候选模型 ${next.provider}/${next.model}（${attempt + 1}/${candidates.length}）。`
        : `${label(reviewer, total)}${reason}；${candidates.length > 1 ? "候选模型已用尽，" : ""}跳过。`,
    );
  }

  /** A reviewer finished with an opinion. */
  async function complete(workspaceId: string, cycle: string, reviewer: PlanReviewer, text: string) {
    const state = current(workspaceId, cycle);
    if (!state) return;
    const total = state.reviewers.length;
    store.taskArtifacts.record({
      workspaceId,
      kind: "plan_review",
      sourceKey: keyOf(cycle, reviewer.index),
      confirmedAt: null,
      source: {
        tabNumber: state.plannerTab,
        agentId: state.plannerAgentId,
        sourceKey: keyOf(cycle, reviewer.index),
      },
      summary: `${label(reviewer, total)}：${text.length > 300 ? text.slice(0, 300) + "…" : text}`,
      data: {
        cycle,
        part: reviewer.index,
        reviewerAgentId: reviewer.agentId,
        provider: reviewer.provider,
        model: reviewer.model,
        text: clip(text),
      },
    });
    update(workspaceId, cycle, (latest) =>
      withReviewer(latest, reviewer.index, (item) => ({ ...item, status: "done" })),
    );
    await status([state.plannerAgentId], `${label(reviewer, total)}已完成审阅。`);
    await toMain(
      workspaceId,
      `#${state.plannerTab} 方案审阅进行中：${label(reviewer, total)}已完成审阅。`,
      "progress",
    );
  }

  function runningReviewer(task: Task | undefined, agentId: string) {
    const state = reviewActive(task);
    const reviewer = state?.reviewers.find(
      (item) => item.agentId === agentId && item.status === "running",
    );
    return state?.status === "reviewing" && reviewer ? { state, reviewer } : undefined;
  }
  /** A turn of some agent started or ended; true when it is a running reviewer. */
  function isReviewer(task: Task | undefined, agentId: string) {
    return !!runningReviewer(task, agentId);
  }
  async function reviewerTurnEnded(
    task: Task,
    agentId: string,
    turnId: string | null,
    outcome: { kind: string },
  ) {
    const found = runningReviewer(task, agentId);
    if (!found) return;
    const { state, reviewer } = found;
    const workspaceId = task.workspaceId;
    if (outcome.kind === "completed") {
      let text = "";
      try {
        text = (await options.turnOutput(agentId, turnId)).trim();
      } catch (error) {
        log("读取审阅意见失败", error);
      }
      if (text) await complete(workspaceId, state.cycle, reviewer, text);
      else await fail(workspaceId, state.cycle, reviewer.index, "审阅者没有输出意见", { retry: true });
    } else {
      await fail(
        workspaceId,
        state.cycle,
        reviewer.index,
        outcome.kind === "failed" ? "审阅回合失败" : `审阅回合未完成（${outcome.kind}）`,
        { retry: outcome.kind === "failed" },
      );
    }
    await advance(workspaceId, state.cycle);
  }

  /** agent.closed / agent.archived of a running reviewer. A user archive gives up on it; a closed
   *  agent (host restart, provider exit) moves to the next candidate model. */
  async function reviewerGone(workspaceId: string, agentId: string, how: "closed" | "archived") {
    const found = runningReviewer(store.tasks.get(workspaceId), agentId);
    if (!found) return;
    await fail(
      workspaceId,
      found.state.cycle,
      found.reviewer.index,
      how === "archived" ? "审阅者已被归档" : "审阅者已关闭",
      { retry: how === "closed" },
    );
    await advance(workspaceId, found.state.cycle);
  }

  /** Plugin start, periodic sweep and task turn events: settle reviewers whose events were missed
   *  (gone, errored, idle without output, past the timeout) and resend an undelivered revise
   *  request. Runs in the flow's queue. */
  async function recover(workspaceId: string) {
    const state = reviewActive(store.tasks.get(workspaceId));
    if (!state) return;
    if (state.status === "revising") {
      if (!state.reviseSentAt) await sendRevise(workspaceId, state.cycle);
      return;
    }
    const timeout = options.timeoutMs?.() ?? DEFAULT_REVIEW_TIMEOUT_MS;
    for (const reviewer of state.reviewers) {
      if (reviewer.status !== "running" || !reviewer.agentId) continue;
      const elapsed = now() - Date.parse(reviewer.startedAt ?? state.startedAt);
      let agent: PaseoAgent | null;
      try {
        const handle = paseo().agents.ref(reviewer.agentId);
        await handle.refresh();
        agent = handle.current();
      } catch (error) {
        // An unreachable host proves nothing about the reviewer; try again on the next sweep.
        log("读取方案审阅者状态失败", error);
        continue;
      }
      const fails = (reason: string, retry = true) =>
        fail(workspaceId, state.cycle, reviewer.index, reason, { retry });
      if (!agent) await fails("审阅者已不存在");
      else if (agent.archivedAt) await fails("审阅者已被归档", false);
      else if (agent.status === "closed") await fails("审阅者已关闭");
      else if (agent.status === "error")
        await fails("审阅者出错" + (agent.lastError ? "：" + agent.lastError : ""));
      else if (agent.status === "idle" && !agent.activeTurn && elapsed > IDLE_GRACE_MS) {
        // Idle: its turn ended while nobody listened. An answer counts; silence is a failure.
        const text = (await options.turnOutput(reviewer.agentId, null).catch(() => "")).trim();
        if (text) await complete(workspaceId, state.cycle, reviewer, text);
        else await fails("审阅者空闲且没有产出");
      } else if (elapsed > timeout) {
        await paseo()
          .agents.ref(reviewer.agentId)
          .cancelRun()
          .catch((error) => log("停止超时审阅者失败", error));
        await fails(`审阅超时（超过 ${Math.round(timeout / 60_000)} 分钟）`);
      }
    }
    await advance(workspaceId, state.cycle);
  }

  /** Every reviewer has finished: the writer revises, or keeps its draft when no opinion came. */
  async function finish(workspaceId: string, cycle: string) {
    const state = current(workspaceId, cycle);
    if (!state || state.status !== "reviewing") return;
    const done = state.reviewers.filter((reviewer) => reviewer.status === "done");
    if (!done.length) {
      savePlan(workspaceId, state.draftPlan);
      update(workspaceId, cycle, (latest) => ({
        ...latest,
        status: "done",
        finishedAt: iso(),
        note: "审阅者全部失败，沿用初稿",
      }));
      const text = `方案审阅者全部失败，沿用 #${state.plannerTab} 的初稿：${state.goal}。可调整方案模型后发送 /重新审阅，或直接确认。`;
      store.tasks.setSummary(workspaceId, text);
      await status([state.plannerAgentId], text);
      await toMain(workspaceId, text);
      return;
    }
    update(workspaceId, cycle, (latest) => ({ ...latest, status: "revising" }));
    const summary = `方案审阅完成（${done.length}/${state.reviewers.length} 位给出意见），等待 #${state.plannerTab} 汇总修订。`;
    store.tasks.setSummary(workspaceId, summary);
    await toMain(workspaceId, summary);
    await sendRevise(workspaceId, cycle);
  }

  /** Sends the opinions to the writer; recovery retries it while it has not gone through. */
  async function sendRevise(workspaceId: string, cycle: string) {
    const state = current(workspaceId, cycle);
    if (!state || state.status !== "revising" || state.reviseSentAt) return;
    const done = state.reviewers.filter((reviewer) => reviewer.status === "done");
    const prompt = store.prompts.resolve(PLAN_REVIEW_REVISE_PROMPT.key, {
      projectId: await options.projectId(workspaceId),
      vars: {
        count: String(done.length),
        reviews: opinions(workspaceId, state, state.reviewers.length),
      },
    });
    try {
      await paseo()
        .agents.ref(state.plannerAgentId)
        .send(prompt, { sourceAgentId: done.at(-1)?.agentId ?? state.plannerAgentId });
      update(workspaceId, cycle, (latest) => {
        const { reviseError: _error, ...rest } = latest;
        return { ...rest, reviseSentAt: iso() };
      });
      await status(
        [state.plannerAgentId],
        `方案审阅完成（${done.length}/${state.reviewers.length} 位给出意见），请 #${state.plannerTab} 汇总修订。`,
      );
    } catch (error) {
      const reason = reasonOf(error);
      log("修订请求发送失败", error);
      update(workspaceId, cycle, (latest) => ({ ...latest, reviseError: reason }));
      // Recovery retries every sweep; tell the user once per distinct reason.
      if (state.reviseError !== reason) {
        const text = `审阅意见没能送达 #${state.plannerTab}：${reason}。插件会自动重试；也可以在 #${state.plannerTab} 说「按审阅意见修订方案」，它下一次输出的方案即为定稿。`;
        await status([state.plannerAgentId], text);
        await toMain(workspaceId, text);
      }
    }
  }

  async function cancelNow(workspaceId: string, state: PlanReviewState, reason: string) {
    update(workspaceId, state.cycle, (latest) => ({
      ...latest,
      status: "cancelled",
      finishedAt: iso(),
      note: reason,
    }));
    for (const reviewer of state.reviewers) {
      if (reviewer.status !== "running" || !reviewer.agentId) continue;
      await paseo()
        .agents.ref(reviewer.agentId)
        .cancelRun()
        .catch((error) => log("停止审阅者失败", error));
    }
    await archiveReviewers(state);
  }
  /** User confirmation or a stop ends an unfinished cycle; returns whether one was active. */
  async function cancel(workspaceId: string, reason: string): Promise<boolean> {
    const state = reviewActive(store.tasks.get(workspaceId));
    if (!state) return false;
    await cancelNow(workspaceId, state, reason);
    await status([state.plannerAgentId], `方案审阅已中止：${reason}`);
    await toMain(workspaceId, `#${state.plannerTab} 方案审阅已中止：${reason}`);
    return true;
  }

  /** The flow panel's review step: progress and every opinion. */
  function panelStep(task: Task) {
    const state = reviewState(task);
    if (!state) return undefined;
    const total = state.reviewers.length;
    const doneCount = state.reviewers.filter((reviewer) => reviewer.status === "done").length;
    const failedCount = state.reviewers.filter((reviewer) => reviewer.status === "failed").length;
    const running = state.reviewers.find((reviewer) => reviewer.status === "running");
    const editedAfter =
      state.status === "done" &&
      !!task.plan &&
      JSON.stringify(task.plan) !== JSON.stringify(state.finalPlan ?? state.draftPlan);
    const summary =
      (state.manual ? "（用户要求重新审阅）" : "") +
      (state.status === "reviewing"
        ? `审阅中：${running ? label(running, total) : "准备下一位"}（已完成 ${doneCount}/${total}）`
        : state.status === "revising"
          ? `审阅完成（${doneCount}/${total} 位给出意见），等待 #${state.plannerTab} 修订` +
            (state.reviseSentAt ? "" : `；修订请求尚未送达${state.reviseError ? `（${state.reviseError}）` : ""}，插件会重试`) +
            "；之后的方案按修订稿（未再审阅）定稿"
          : state.status === "done"
            ? (state.note ??
                `已定稿：${doneCount} 位审阅者给出意见${failedCount ? `，${failedCount} 位失败` : ""}；定稿为修订稿（未再审阅）`) +
              (editedAfter
                ? `；之后 #${state.plannerTab} 又更新了方案（未审阅），需要时发送 /重新审阅`
                : "")
            : `审阅中止：${state.note ?? ""}`);
    const detail = [
      `方案：${state.goal}`,
      ...state.reviewers.map((reviewer) => {
        const head = `【${label(reviewer, total)} · ${STATUS_LABELS[reviewer.status]}】`;
        const body =
          reviewer.status === "done"
            ? clip(opinion(task.workspaceId, state.cycle, reviewer.index) ?? "", 3_000)
            : (reviewer.error ?? "");
        return body ? `${head}\n${body}` : head;
      }),
    ].join("\n\n");
    return {
      kind: "plan_review",
      title: "方案审阅",
      summary,
      detail,
      createdAt: state.finishedAt ?? state.startedAt,
    };
  }

  return {
    onPlannerPlan,
    restart,
    isReviewer,
    reviewerTurnEnded,
    reviewerGone,
    recover,
    cancel,
    panelStep,
  };
}
export type PlanReview = ReturnType<typeof createPlanReview>;
