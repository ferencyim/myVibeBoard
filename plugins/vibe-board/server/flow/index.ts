// The card's plan / execution buttons (WP-105) behind the RPCs:
//   制定方案   -> a plan-thread owner message with action "make_plan"; the planning session
//                (vibe-master/server/planning) scouts on the card's scout model, then plans on its
//                planning model. Nothing calls another plugin: the message is the instruction.
//   复核方案   -> the same with action "review_plan" (WP-108): the plan reviewer model reads the plan,
//                the planning model revises it with that opinion.
//   立即执行   -> draft is moved to todo by the owner, then the card is dispatched at once (force)
//                to its executing model; review and evidence verification follow on verifying.
//                Every card is verified (WP-108): without a verification model nothing starts.
//   执行模型   -> while a worker runs, picking another model hands the work over (reassigner.switchTo).
//   子任务     -> the owner's version of the plan's subtasks (WP-106); a new model for a subtask whose
//                sub-agent is running applies to the sub-agents started later, said in the exec chat.

import {
  ACTIVE_SUBTASK_STATUSES,
  resolveModel,
  runOf,
  subtasksOf,
  type CardView,
  type ChatThread,
  type ModelRole,
  type MoveActor,
  type Subtask,
} from "../vibe/contract";
import { postChat } from "../chat/post";
import { BoardError, toBoardError, type BoardService } from "../service";
import type { Dispatcher } from "../dispatch";
import type { Reassigner } from "../dispatch/reassign";

type UiActor = Extract<MoveActor, "user" | "phone">;

/** Worker states in which a session is executing the card. */
const RUNNING = ["starting", "working", "waiting", "idle", "error"] as const;

export interface FlowOptions {
  board: BoardService;
  dispatcher: Pick<Dispatcher, "dispatch">;
  reassigner: Pick<Reassigner, "switchTo">;
  /** Wakes the chat router / planner pollers after a write (optional, they poll anyway). */
  onMessage?: () => void;
}

export const MAKE_PLAN_TEXT = "请制定方案。";
export const REVIEW_PLAN_TEXT = "请复核方案。";

/** Why a job of the card has no model (card, project and global default all empty). */
export const NO_MODEL: Partial<Record<ModelRole, string>> = {
  planner: "请先在方案页选择规划模型（或在项目 / 全局设置默认规划模型）",
  plan_reviewer: "请先在方案页选择方案复核模型（或在项目 / 全局设置默认方案复核模型）",
  verifier: "还没有验证模型：每张卡都要验证，请先在验证页选择验证模型（或在项目 / 全局设置默认验证模型）",
};

export function createFlowService(options: FlowOptions) {
  const { board, dispatcher, reassigner } = options;
  const { store } = board;

  /** The card's model for a job (card -> project -> global, WP-108); throws when there is none. */
  function requireModel(card: CardView, role: ModelRole): string {
    const { presetId } = resolveModel(
      role,
      card,
      store.projects.get(card.projectId),
      store.modelDefaults.global(),
      (id) => !!store.presets.get(id),
    );
    if (!presetId) throw new BoardError("invalid", NO_MODEL[role] ?? `没有${role}模型`);
    return presetId;
  }

  function planMessage(ref: string, actor: UiActor, action: "make_plan" | "review_plan") {
    try {
      const card = board.cards.get(ref);
      const what = action === "make_plan" ? "制定方案" : "复核方案";
      if (card.column === "done") throw new BoardError("invalid", `${card.key} 已完成，不能再${what}`);
      requireModel(card, "planner");
      if (action === "review_plan") {
        if (!card.plan?.description.trim() && !card.plan?.subtasks?.length) {
          throw new BoardError("invalid", "还没有方案：先制定方案，再复核");
        }
        requireModel(card, "plan_reviewer");
      }
      const event = store.cards.addChat({
        cardId: card.id,
        authorKind: "user",
        author: actor,
        text: action === "make_plan" ? MAKE_PLAN_TEXT : REVIEW_PLAN_TEXT,
        thread: "plan" satisfies ChatThread,
        action,
      });
      options.onMessage?.();
      return { event };
    } catch (error) {
      throw toBoardError(error);
    }
  }

  const planStart = (ref: string, actor: UiActor = "user") => planMessage(ref, actor, "make_plan");
  const planReview = (ref: string, actor: UiActor = "user") => planMessage(ref, actor, "review_plan");

  async function execStart(ref: string) {
    try {
      let card = board.cards.get(ref);
      if (card.column === "draft" || card.column === "todo") requireModel(card, "verifier");
      if (card.column === "draft") {
        card = store.cards.move(card.id, { to: "todo", actor: "user", reason: "立即执行" });
      }
      if (card.column !== "todo") {
        throw new BoardError("illegal_transition", `${card.key} 已经在执行或已完成`);
      }
      const { card: moved, session } = await dispatcher.dispatch(card.id, { force: true });
      return { card: moved, session };
    } catch (error) {
      throw toBoardError(error);
    }
  }

  /** Pick the executing model; while a worker runs on the card, hand the work over to it. */
  async function execSwitch(ref: string, presetId: string | null) {
    try {
      const card = board.cards.get(ref);
      const running = store.sessions.list({ cardId: card.id, role: "worker", states: [...RUNNING] }).at(-1);
      if (!running || !presetId || presetId === card.presetId) {
        return { card: store.cards.update(card.id, { presetId }), switched: false };
      }
      await reassigner.switchTo(running.id, presetId);
      return { card: store.cards.get(card.id)!, switched: true };
    } catch (error) {
      throw toBoardError(error);
    }
  }

  function setSubtasks(ref: string, subtasks: readonly Subtask[], actor: UiActor = "user") {
    try {
      const card = board.cards.get(ref);
      const before = new Map(subtasksOf(card).map((s) => [s.id, s]));
      const next = store.cards.setSubtasks(card.id, subtasks, actor);
      const presets = store.presets.list();
      for (const s of subtasks) {
        const old = before.get(s.id);
        if (!old || old.presetId === s.presetId || !ACTIVE_SUBTASK_STATUSES.includes(runOf(card, s.id).status)) continue;
        const name = presets.find((p) => p.id === s.presetId)?.name ?? "子代理默认模型";
        postChat(store, {
          cardId: card.id,
          authorKind: "system",
          author: "subtasks",
          kind: "info",
          thread: "exec",
          subtask: s.id,
          text: `子任务 ${s.id} 改用「${name}」：正在运行的子代理不受影响，之后启动的子代理使用新模型。`,
          key: `subtask-model:${s.id}:${next.updatedAt}`,
        });
      }
      return { card: next };
    } catch (error) {
      throw toBoardError(error);
    }
  }

  return { planStart, planReview, execStart, execSwitch, setSubtasks };
}

export type FlowService = ReturnType<typeof createFlowService>;
