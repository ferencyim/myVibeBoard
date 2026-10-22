// Pure helpers of the subtask views (WP-106): the editor on the plan tab and the subtask list of the
// execution tab.

import {
  SUBTASK_STATUS_LABELS,
  runOf,
  subtaskListError,
  subtasksOf,
  type AgentSession,
  type CardView,
  type Preset,
  type Subtask,
  type SubtaskStatus,
} from "../../shared/vibe/contract";

/** A new, empty subtask with the next free id ("s1", "s2", ...). */
export function newSubtask(list: readonly Subtask[]): Subtask {
  const used = new Set(list.map((s) => s.id));
  let n = list.length + 1;
  while (used.has(`s${n}`)) n++;
  return {
    id: `s${n}`,
    title: `子任务 ${n}`,
    goal: "",
    method: "",
    notes: "",
    acceptance: "",
    files: [],
    dependsOn: [],
    presetId: null,
  };
}

/** Remove a subtask and every dependency on it. */
export function removeSubtask(list: readonly Subtask[], id: string): Subtask[] {
  return list.filter((s) => s.id !== id).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) }));
}

export function patchSubtask(list: readonly Subtask[], id: string, patch: Partial<Subtask>): Subtask[] {
  return list.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Toggle `dep` in the dependencies of `id`. */
export function toggleDependency(list: readonly Subtask[], id: string, dep: string): Subtask[] {
  return list.map((s) =>
    s.id !== id
      ? s
      : { ...s, dependsOn: s.dependsOn.includes(dep) ? s.dependsOn.filter((d) => d !== dep) : [...s.dependsOn, dep] },
  );
}

/** "a.ts, src/b/**" or one per line -> list (blank entries dropped). */
export const splitList = (text: string): string[] =>
  text
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Why the edited list cannot be saved (blank title, ids, dependencies), or null. */
export function editError(list: readonly Subtask[]): string | null {
  const blank = list.find((s) => !s.title.trim());
  if (blank) return `子任务 ${blank.id} 需要标题`;
  return subtaskListError(list);
}

export interface SubtaskRow {
  id: string;
  title: string;
  status: SubtaskStatus;
  statusLabel: string;
  /** Model of the running/last sub-agent, else the one it will start on. */
  model: string;
  /** The subtask's own model differs from the one its running sub-agent uses (changed meanwhile). */
  modelChanged: boolean;
  dependsOn: string[];
  agentId: string | null;
  /** The sub-agent's question (waiting), its summary (done) or the failure. */
  note: string;
  attempts: number;
}

/** Rows of the execution tab's subtask list. */
export function subtaskRows(
  card: Pick<CardView, "plan" | "subtaskRuns" | "subagentPresetId" | "presetId">,
  presets: readonly Preset[],
  sessions: readonly AgentSession[] = [],
): SubtaskRow[] {
  const nameOf = (id: string | null | undefined) => (id ? presets.find((p) => p.id === id)?.name : undefined);
  const fallback = nameOf(card.subagentPresetId) ?? nameOf(card.presetId);
  return subtasksOf(card).map((s) => {
    const run = runOf(card, s.id);
    const planned = nameOf(s.presetId) ?? (fallback ? `${fallback}（默认）` : "默认");
    const active = run.status === "running" || run.status === "waiting";
    const session = run.sessionId ? sessions.find((x) => x.id === run.sessionId) : undefined;
    return {
      id: s.id,
      title: s.title,
      status: run.status,
      statusLabel: SUBTASK_STATUS_LABELS[run.status],
      model: active || run.status === "done" ? (nameOf(run.presetId) ?? session?.currentProvider ?? planned) : planned,
      modelChanged: active && !!s.presetId && !!run.presetId && s.presetId !== run.presetId,
      dependsOn: s.dependsOn,
      agentId: run.agentId,
      note: run.status === "failed" ? run.error || run.summary : run.summary,
      attempts: run.attempts,
    };
  });
}

/** One line per subtask, for proposal before/after views. */
export function subtasksText(list: readonly Subtask[] | undefined, presets: readonly Preset[] = []): string {
  if (!list?.length) return "（无子任务）";
  return list
    .map((s) => {
      const model = s.presetId ? presets.find((p) => p.id === s.presetId)?.name : undefined;
      const extra = [s.dependsOn.length ? `依赖 ${s.dependsOn.join(", ")}` : "", model ? `模型 ${model}` : ""]
        .filter(Boolean)
        .join("；");
      return `${s.id} · ${s.title}${extra ? `（${extra}）` : ""}`;
    })
    .join("\n");
}
