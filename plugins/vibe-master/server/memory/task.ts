import { existsSync } from "node:fs";
import { parseReply } from "../assess/parse";
import { MemoryUpdateSchema, type MemoryUpdate } from "../assess/schema";
import {
  buildRepairMessage,
  DEFAULT_REQUIREMENTS_CHARS,
  requirementsExcerpt,
} from "../master/prompts";
import type { PromptPort } from "../prompts/port";
import { defaultPromptPort } from "../prompts/port";
import type { MasterStateFile } from "../subscription/state";
import type { TuningSource } from "../tuning";
import { defaultTuning } from "../tuning";
import type { MasterAsk } from "../types";
import type { Project, Task, TaskPlan } from "../vibe/contract";
import type { GitRunner, VibeDb, VibeStore } from "../vibe/db";
import { writeRequirementsDoc } from "../vibe/db";
import type { ApplyResult, MemoryPort } from "./files";

export interface ConsolidateDeps {
  db: VibeDb;
  store: VibeStore;
  master: MasterAsk;
  memory: MemoryPort;
  /** Prompt texts (registry); built-in defaults when omitted. */
  prompts?: PromptPort;
  /** Owner settings (read on every use). All optional: 6000 chars, no requirements writes, default tuning. */
  options?: {
    requirementsChars?(): number;
    maintainRequirements?(): boolean;
    tuning?: TuningSource;
  };
  /** A requirements update failed: remind the owner (once per cooldown). */
  onRequirementsFailure?(workspaceId: string, message: string): void;
  /** Injectable git for the requirements commit. */
  git?: GitRunner;
  log?: (message: string, error?: unknown) => void;
}

export type ConsolidateOutcome =
  | { status: "updated"; summary: string; applied: ApplyResult }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: "not_found" | "not_done" | "no_repo" | "already_done" };

export interface TaskConsolidateDeps extends ConsolidateDeps {
  state: MasterStateFile;
  withWrite?<T>(task: Task, files: string[], action: () => Promise<T>): Promise<T>;
  project(workspaceId: string): Promise<Project | undefined>;
  /** Native summary only. This must not create a user message or start a new task. */
  report?(task: Task, summary: string): Promise<void>;
}
export const consolidationKey = (task: Task) => task.workspaceId + ":" + task.confirmedAt;

function complete(task: Task | undefined): task is Task & { plan: TaskPlan; confirmedAt: string } {
  return !!task && task.phase === "completed" && !!task.confirmedAt && !!task.plan;
}

/** Completed tasks carry all context in the task snapshot; no card or old event is consulted. */
export function createTaskConsolidator(deps: TaskConsolidateDeps) {
  const prompts = deps.prompts ?? defaultPromptPort();
  const tuning = deps.options?.tuning ?? defaultTuning;
  const requirementsChars = () => deps.options?.requirementsChars?.() ?? DEFAULT_REQUIREMENTS_CHARS;
  const allowRequirements = (truncated: boolean) =>
    !!deps.options?.maintainRequirements?.() && !truncated;
  const has = (task: Task) =>
    deps.state.read().taskConsolidations?.[consolidationKey(task)]?.status === "completed";
  async function consolidate(
    workspaceId: string,
    options: { force?: boolean } = {},
  ): Promise<ConsolidateOutcome> {
    const task = deps.store.tasks.get(workspaceId);
    if (!task) return { status: "skipped", reason: "not_found" };
    if (!complete(task)) return { status: "skipped", reason: "not_done" };
    if (!options.force && has(task)) return { status: "skipped", reason: "already_done" };
    const project = await deps.project(workspaceId);
    if (!project?.repoPath || !existsSync(project.repoPath))
      return { status: "skipped", reason: "no_repo" };
    const maxChars = requirementsChars();
    const excerpt = requirementsExcerpt(project, maxChars);
    const memory = Object.entries(deps.memory.snapshot(project.repoPath))
      .map(
        ([file, entries]) =>
          "### " +
          file +
          "\n" +
          entries.map((entry) => "- [" + entry.id + "] " + entry.body).join("\n"),
      )
      .join("\n");
    const prompt = prompts.resolve("master.wake.task_done", {
      projectId: project.id,
      vars: {
        project:
          "项目：" +
          project.name +
          "\n" +
          project.description +
          "\n" +
          (excerpt?.text ?? "（没有需求文档）"),
        workspace: workspaceId,
        plan: JSON.stringify(task.plan),
        summary: task.summary || "（没有摘要）",
        runs: JSON.stringify(task.subtaskRuns),
        memory: memory || "（空）",
      },
    });
    let parsed = parseReply(await deps.master.ask(prompt), MemoryUpdateSchema);
    for (let retry = 0; retry < tuning().jsonRepairRetries && !parsed.ok; retry++) {
      parsed = parseReply(
        await deps.master.ask(buildRepairMessage("task_done", parsed.error, prompts, project.id)),
        MemoryUpdateSchema,
      );
    }
    if (!parsed.ok) return { status: "failed", error: parsed.error };
    // Completion can be reopened while a model turn is running. Never apply its stale answer.
    const current = deps.store.tasks.get(workspaceId);
    if (!complete(current) || current.confirmedAt !== task.confirmedAt)
      return { status: "skipped", reason: "not_done" };
    const update: MemoryUpdate = parsed.value;
    const key = consolidationKey(task);
    // Save the validated answer first: a restart after a file write reuses it instead of asking again.
    deps.state.update((state) => ({
      ...state,
      taskConsolidations: {
        ...state.taskConsolidations,
        [key]: {
          status: "pending",
          update,
          repoPath: project.repoPath!,
          requirementsPath: project.requirementsPath,
          requirementsAllowed: allowRequirements(excerpt?.truncated === true),
        },
      },
    }));
    return apply(task, project);
  }
  async function apply(task: Task, project: Project): Promise<ConsolidateOutcome> {
    const pending = deps.state.read().taskConsolidations?.[consolidationKey(task)];
    if (!pending) return { status: "skipped", reason: "already_done" };
    if (pending.repoPath !== project.repoPath)
      return { status: "failed", error: "项目目录已变化，请核对待落实的记忆整理结果" };
    const run = () => applyLocked(task);
    return deps.withWrite
      ? deps.withWrite(task, [".vibe/**", pending.requirementsPath], run)
      : run();
  }
  async function applyLocked(task: Task): Promise<ConsolidateOutcome> {
    const key = consolidationKey(task);
    const pending = deps.state.read().taskConsolidations?.[key];
    if (!pending) return { status: "skipped", reason: "already_done" };
    if (pending.status === "completed") return { status: "skipped", reason: "already_done" };
    const currentTask = deps.store.tasks.get(task.workspaceId);
    if (!complete(currentTask) || currentTask.confirmedAt !== task.confirmedAt)
      return { status: "skipped", reason: "not_done" };
    const applied = deps.memory.apply(pending.repoPath, pending.update);
    let requirements = pending.requirementsResult ?? "";
    if (!pending.requirementsResult && pending.update.requirementsUpdate) {
      if (!pending.requirementsAllowed) {
        requirements = "需求文档维护已关闭或摘录不完整，未更新需求文档。";
      } else {
        try {
          const update = pending.update.requirementsUpdate;
          const result = await writeRequirementsDoc(
            pending.repoPath,
            pending.requirementsPath,
            update.content.endsWith("\n") ? update.content : update.content + "\n",
            "文档：" + update.summary.replace(/\s+/g, " ").trim(),
            deps.git,
          );
          requirements = result.committed
            ? "需求文档已单文件提交：" + result.commit
            : "需求文档内容未变化。";
        } catch (error) {
          requirements =
            "需求文档更新失败：" + (error instanceof Error ? error.message : String(error));
          deps.onRequirementsFailure?.(task.workspaceId, requirements);
        }
      }
      deps.state.update((state) => ({
        ...state,
        taskConsolidations: {
          ...state.taskConsolidations,
          [key]: { ...pending, requirementsResult: requirements },
        },
      }));
    }
    const summary =
      "项目记忆已整理：" + pending.update.summary + (requirements ? "\n" + requirements : "");
    const current = deps.store.tasks.get(task.workspaceId)!;
    if (!current.summary.includes(summary))
      deps.store.tasks.setSummary(
        task.workspaceId,
        [current.summary, summary].filter(Boolean).join("\n\n"),
      );
    // Mark before reporting: a transient native timeline failure must not repeat document commits.
    deps.state.update((state) => ({
      ...state,
      taskConsolidations: {
        ...state.taskConsolidations,
        [key]: { ...pending, requirementsResult: requirements, status: "completed" },
      },
    }));
    try {
      await deps.report?.(task, summary);
    } catch (error) {
      deps.log?.("完成整理摘要投递失败，任务摘要已保存", error);
    }
    return { status: "updated", summary: pending.update.summary, applied };
  }
  return {
    has,
    async consolidate(workspaceId: string, options: { force?: boolean } = {}) {
      const task = deps.store.tasks.get(workspaceId);
      const pending = task && deps.state.read().taskConsolidations?.[consolidationKey(task)];
      if (task?.phase === "completed" && pending?.status === "pending") {
        const project = await deps.project(workspaceId);
        if (!project) return { status: "skipped", reason: "no_repo" } as const;
        return apply(task, project);
      }
      return consolidate(workspaceId, options);
    },
  };
}
