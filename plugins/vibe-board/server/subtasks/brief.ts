// Texts of the sub-agent flow (WP-106), pure: the subtask list in the main agent's brief, a
// sub-agent's first message and the notifications the main agent receives.

import {
  SUBTASK_STATUS_LABELS,
  runOf,
  subtasksOf,
  type CardView,
  type Preset,
  type Subtask,
  type SubtaskRun,
} from "../vibe/contract";
import { defaultPrompts, type PromptResolver } from "../prompts";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const orNone = (text: string) => text.trim() || "无。";

/** Display name of the model a subtask runs on: its own pick, else the card's sub-agent default. */
export function subtaskModelLabel(subtask: Subtask, card: Pick<CardView, "subagentPresetId" | "presetId">, presets: readonly Preset[]): string {
  const own = subtask.presetId ? presets.find((p) => p.id === subtask.presetId) : undefined;
  if (own) return own.name;
  const fallback = presets.find((p) => p.id === (card.subagentPresetId ?? card.presetId));
  return fallback ? `${fallback.name}（默认）` : "默认";
}

/** One subtask as the main agent reads it. */
export function renderSubtask(subtask: Subtask, model: string, run?: SubtaskRun): string {
  const head = `### ${subtask.id} · ${subtask.title}`;
  const meta = [
    `模型：${model}`,
    subtask.dependsOn.length ? `依赖：${subtask.dependsOn.join(", ")}` : "无依赖",
    run ? `状态：${SUBTASK_STATUS_LABELS[run.status]}` : "",
  ]
    .filter(Boolean)
    .join("；");
  return [
    `${head}（${meta}）`,
    `- 目标：${orNone(subtask.goal)}`,
    `- 方法：${orNone(subtask.method)}`,
    subtask.notes.trim() ? `- 注意事项：${subtask.notes.trim()}` : "",
    `- 验收标准：${orNone(subtask.acceptance)}`,
    `- 涉及文件：${subtask.files.length ? subtask.files.join(", ") : "未列出"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The `{{subtasks}}` segment of the main agent's brief ("" when the plan has no subtasks). */
export function subtasksSegment(card: CardView, presets: readonly Preset[], prompts: PromptResolver = defaultPrompts): string {
  const subtasks = subtasksOf(card);
  if (subtasks.length === 0) return "";
  const intro = prompts.resolve("board.orchestrate", { projectId: card.projectId, vars: { "card.key": card.key } });
  const list = subtasks.map((s) => renderSubtask(s, subtaskModelLabel(s, card, presets))).join("\n\n");
  return `## 子任务（由你统筹）\n${intro.trim()}\n\n${list}\n\n`;
}

/** A sub-agent's first message. */
export function buildSubtaskBrief(input: {
  card: CardView;
  subtask: Subtask;
  extra?: string;
  prompts?: PromptResolver;
}): string {
  const { card, subtask } = input;
  const prompts = input.prompts ?? defaultPrompts;
  const plan = card.plan?.description.trim();
  return `${prompts
    .resolve("board.subtask_brief", {
      projectId: card.projectId,
      vars: {
        "card.key": card.key,
        "card.title": card.title,
        "subtask.id": subtask.id,
        "subtask.title": subtask.title,
        goal: orNone(subtask.goal),
        method: orNone(subtask.method),
        notes: orNone(subtask.notes),
        acceptance: orNone(subtask.acceptance),
        files: subtask.files.length ? subtask.files.map((f) => `- ${f}`).join("\n") : "未列出（按目标自行判断，尽量少改）。",
        description: card.description.trim() ? `## 卡片描述\n${clip(card.description.trim(), 3000)}\n\n` : "",
        plan: plan ? `## 卡片方案（全局背景）\n${clip(plan, 4000)}\n\n` : "",
        extra: input.extra?.trim() ? `## 主代理补充说明\n${input.extra.trim()}\n\n` : "",
      },
    })
    .trimEnd()}\n`;
}

export interface SubtaskUpdate {
  subtask: Subtask;
  run: SubtaskRun;
}

/** One line per status change for the main agent. */
export function updateLine({ subtask, run }: SubtaskUpdate): string {
  const name = `${subtask.id}「${subtask.title}」`;
  switch (run.status) {
    case "done":
      return `- ${name} 已完成。小结：${clip(run.summary.trim() || "（无）", 1500)}`;
    case "failed":
      return `- ${name} 失败：${clip(run.error.trim() || run.summary.trim() || "未知原因", 800)}`;
    case "waiting":
      return `- ${name} 的子代理在提问：${clip(run.summary.trim() || "（见它的会话）", 1500)}`;
    case "running":
      return `- ${name} 继续运行中。`;
    default:
      return `- ${name} 回到待开始。`;
  }
}

/** Status overview of all subtasks ("s1 完成 / s2 进行中 ..."). */
export function overviewLines(card: CardView): string {
  return subtasksOf(card)
    .map((s) => `- ${s.id}「${s.title}」：${SUBTASK_STATUS_LABELS[runOf(card, s.id).status]}`)
    .join("\n");
}

export function buildNotifyMessage(card: CardView, updates: readonly SubtaskUpdate[], prompts: PromptResolver = defaultPrompts): string {
  return prompts.resolve("board.subtask_notify", {
    projectId: card.projectId,
    vars: {
      "card.key": card.key,
      updates: updates.map(updateLine).join("\n"),
      overview: overviewLines(card) || "（方案里没有子任务）",
    },
  });
}
