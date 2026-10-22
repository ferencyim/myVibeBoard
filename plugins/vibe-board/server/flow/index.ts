// The card's plan / execution buttons (WP-105) behind the RPCs:
//   制定方案   -> a plan-thread owner message with action "make_plan"; the planning session
//                (vibe-master/server/planning) scouts on the card's scout model, then plans on its
//                planning model. Nothing calls another plugin: the message is the instruction.
//   立即执行   -> draft is moved to todo by the owner, then the card is dispatched at once (force)
//                to its executing model; review and evidence verification follow on verifying.
//   执行模型   -> while a worker runs, picking another model hands the work over (reassigner.switchTo).
//   子任务     -> the owner's version of the plan's subtasks (WP-106); a new model for a subtask whose
//                sub-agent is running applies to the sub-agents started later, said in the exec chat.

import { ACTIVE_SUBTASK_STATUSES, runOf, subtasksOf, type ChatThread, type MoveActor, type Subtask } from "../vibe/contract";
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

export function createFlowService(options: FlowOptions) {
  const { board, dispatcher, reassigner } = options;
  const { store } = board;

  function planStart(ref: string, actor: UiActor = "user") {
    try {
      const card = board.cards.get(ref);
      if (card.column === "done") throw new BoardError("invalid", `${card.key} 已完成，不能再制定方案`);
      if (!card.plannerPresetId) throw new BoardError("invalid", "请先在方案页顶部选择规划模型");
      const event = store.cards.addChat({
        cardId: card.id,
        authorKind: "user",
        author: actor,
        text: MAKE_PLAN_TEXT,
        thread: "plan" satisfies ChatThread,
        action: "make_plan",
      });
      options.onMessage?.();
      return { event };
    } catch (error) {
      throw toBoardError(error);
    }
  }

  async function execStart(ref: string) {
    try {
      let card = board.cards.get(ref);
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

  return { planStart, execStart, execSwitch, setSubtasks };
}

export type FlowService = ReturnType<typeof createFlowService>;
