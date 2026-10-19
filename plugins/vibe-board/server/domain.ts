import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  displayName,
  TASK_CARD_KIND,
  type TaskStatus,
  type TaskThreadLiveStatus,
} from "../shared/constants";
import type {
  Attachment as AttachmentMetadata,
  CommentProvider,
  DisplayComment,
  PaseoProjectOption,
  SidebarProjectSummary,
  Task as ApiTask,
  TaskPullRequest,
  TasksDomainError,
} from "../shared/contract";
import {
  AttachmentReferencedError,
  deleteAttachmentById,
  readAttachmentContent,
  removeAttachmentBlobs,
  saveAttachmentFromBytes,
} from "./attachments";
import { openTasksDatabase, tasksDataDir, type PluginDatabase } from "./sqlite";
import { createTasksStore, escapeLike, type TasksStore } from "./store";
import type {
  Attachment as StoredAttachment,
  Comment as StoredComment,
  Preset,
  Project,
  Task as StoredTask,
  TaskThread,
} from "./types";

const execFileAsync = promisify(execFile);

const MAX_DELEGATED_THREAD_TITLE_WIDTH = 120;
const SYSTEM_AUTHOR_NAME = "Tasks";
const MANUAL_PRESET_NAME = "Attached";
const RECENT_COMMENT_LIMIT = 5;

interface TaskLabelIdRow {
  task_id: string;
  label_id: string;
}

interface CountRow {
  count: number;
}

interface PrefixRow {
  found: number;
}

interface SummaryRow {
  project_id: string;
  task_count: number;
  active_agent_count: number;
}

export interface TasksApiStore {
  readonly db: PluginDatabase;
  readonly tasks: TasksStore;
  readonly dataDir: string;
  transaction<T>(operation: () => T): T;
  taskLabelIds(taskIds: readonly string[]): Map<string, string[]>;
  projectTaskCount(projectId: string): number;
  projectPrefixExists(prefix: string, excludingProjectId: string): boolean;
  openTaskCount(): number;
  sidebarSummary(): SidebarProjectSummary[];
  ensureDefaultPresets(): void;
}

export function createApiStore(
  database: PluginDatabase = openTasksDatabase(),
  dataDir = tasksDataDir(),
): TasksApiStore {
  const tasks = createTasksStore(database);

  return {
    db: database,
    tasks,
    dataDir,
    transaction<T>(operation: () => T): T {
      return database.transaction(operation)();
    },
    taskLabelIds(taskIds: readonly string[]): Map<string, string[]> {
      const labelsByTask = new Map<string, string[]>();
      for (const taskId of taskIds) labelsByTask.set(taskId, []);

      for (let offset = 0; offset < taskIds.length; offset += 500) {
        const ids = taskIds.slice(offset, offset + 500);
        if (ids.length === 0) continue;
        const placeholders = ids.map(() => "?").join(", ");
        const rows = database
          .prepare<string[], TaskLabelIdRow>(
            `
              SELECT task_id, label_id
              FROM task_labels
              WHERE task_id IN (${placeholders})
              ORDER BY task_id, label_id
            `,
          )
          .all(...ids);
        for (const row of rows) {
          labelsByTask.get(row.task_id)?.push(row.label_id);
        }
      }
      return labelsByTask;
    },
    projectTaskCount(projectId: string): number {
      return (
        database
          .prepare<[string], CountRow>(
            "SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?",
          )
          .get(projectId)?.count ?? 0
      );
    },
    projectPrefixExists(prefix: string, excludingProjectId: string): boolean {
      return Boolean(
        database
          .prepare<[string, string], PrefixRow>(
            `
              SELECT 1 AS found FROM projects
              WHERE prefix = ? COLLATE NOCASE AND id <> ?
              LIMIT 1
            `,
          )
          .get(prefix, excludingProjectId),
      );
    },
    openTaskCount(): number {
      return (
        database
          .prepare<[], CountRow>(
            `
              SELECT COUNT(*) AS count
              FROM tasks
              WHERE status NOT IN ('done', 'canceled')
            `,
          )
          .get()?.count ?? 0
      );
    },
    sidebarSummary(): SidebarProjectSummary[] {
      return database
        .prepare<[], SummaryRow>(
          `
            SELECT
              p.id AS project_id,
              COUNT(DISTINCT t.id) AS task_count,
              COUNT(DISTINCT CASE
                WHEN tt.live_status IN ('starting', 'working') THEN tt.thread_id
              END) AS active_agent_count
            FROM projects p
            LEFT JOIN tasks t
              ON t.project_id = p.id
              AND t.parent_task_id IS NULL
            LEFT JOIN task_threads tt ON tt.task_id = t.id
            GROUP BY p.id
            ORDER BY p.name COLLATE NOCASE, p.id
          `,
        )
        .all()
        .map((row) => ({
          projectId: row.project_id,
          taskCount: row.task_count,
          activeAgentCount: row.active_agent_count,
        }));
    },
    ensureDefaultPresets(): void {
      if (tasks.listPresets().length > 0) return;
      const defaults = [
        {
          name: "Codex · High (Worktree)",
          providerId: "codex",
          modelId: "gpt-5.4",
          reasoningLevel: "high",
          serviceTier: null,
          permissionMode: "auto" as const,
          environmentKind: "new-worktree" as const,
          baseBranch: null,
          machineId: null,
          instructions:
            "Implement the task cleanly in this worktree, run focused tests, post a milestone comment with paseo-tasks comment, and move the task to in_review when ready.",
          builtin: true,
        },
        {
          name: "Claude · Sonnet (Default)",
          providerId: "claude",
          modelId: "claude-sonnet-5-5",
          reasoningLevel: "medium",
          serviceTier: null,
          permissionMode: "accept-edits" as const,
          environmentKind: "project-default" as const,
          baseBranch: null,
          machineId: null,
          instructions:
            "Inspect the task with paseo-tasks show, implement the requested change, and report validation results back to the task.",
          builtin: true,
        },
        {
          name: "OpenCode · Gemini High",
          providerId: "opencode",
          modelId: "opencode-go/gemini-4-argon-contributor",
          reasoningLevel: "high",
          serviceTier: null,
          permissionMode: "auto" as const,
          environmentKind: "project-default" as const,
          baseBranch: null,
          machineId: null,
          instructions:
            "Complete the task, run verification, leave a concise comment with paseo-tasks comment, and set status to in_review.",
          builtin: true,
        },
      ];
      for (const preset of defaults) {
        try {
          tasks.createPreset(preset);
        } catch {}
      }
    },
  };
}

class TasksDomainFailure extends Error {
  constructor(readonly detail: TasksDomainError) {
    super(detail.message);
    this.name = "TasksDomainFailure";
  }
}

function fail(code: TasksDomainError["code"], message: string): never {
  throw new TasksDomainFailure({ code, message });
}

function taskFailure(error: TasksDomainFailure) {
  return { ok: false as const, error: error.detail };
}

export function apiTask(store: TasksApiStore, task: StoredTask): ApiTask {
  return {
    ...task,
    labelIds: store.taskLabelIds([task.id]).get(task.id) ?? [],
  };
}

export function apiTasks(
  store: TasksApiStore,
  tasks: readonly StoredTask[],
): ApiTask[] {
  const labelsByTask = store.taskLabelIds(tasks.map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    labelIds: labelsByTask.get(task.id) ?? [],
  }));
}

function attachmentMetadata(attachment: StoredAttachment): AttachmentMetadata {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    commentId: attachment.commentId,
    fileName: attachment.fileName,
    mime: attachment.mime,
    sizeBytes: attachment.sizeBytes,
    isImage: attachment.isImage,
    createdAt: attachment.createdAt,
  };
}

function attachmentsForTasks(
  store: TasksStore,
  taskIds: readonly string[],
): StoredAttachment[] {
  return taskIds.flatMap((taskId) => [
    ...store.listAttachmentsForTask(taskId),
    ...store
      .listComments(taskId)
      .flatMap((comment) => store.listAttachmentsForComment(comment.id)),
  ]);
}

function validateTaskParent(
  store: TasksApiStore,
  projectId: string,
  parentTaskId: string | null,
  ownTaskId?: string,
): void {
  if (parentTaskId === null) return;
  if (parentTaskId === ownTaskId) {
    fail("task_parent_invalid", "A task cannot be its own parent");
  }
  const parent = store.tasks.getTask(parentTaskId);
  if (!parent) throw new Error(`Task not found: ${parentTaskId}`);
  if (parent.projectId !== projectId) {
    fail(
      "subtask_project_mismatch",
      "A sub-task must belong to the same project as its parent",
    );
  }
  if (parent.parentTaskId !== null) {
    fail(
      "subtask_depth_exceeded",
      "Tasks support at most one level of sub-tasks",
    );
  }
  if (ownTaskId && store.tasks.listSubtasks(ownTaskId).length > 0) {
    fail(
      "subtask_depth_exceeded",
      "A task with sub-tasks cannot itself become a sub-task",
    );
  }
}

function validateTaskLabels(
  store: TasksApiStore,
  projectId: string,
  labelIds: readonly string[],
): void {
  for (const labelId of labelIds) {
    const label = store.tasks.getLabel(labelId);
    if (!label || label.projectId !== projectId) {
      fail(
        "label_project_mismatch",
        `Task labels must belong to the task project: ${labelId}`,
      );
    }
  }
}

function replaceTaskLabels(
  store: TasksApiStore,
  taskId: string,
  labelIds: readonly string[],
): void {
  const current = new Set(
    store.tasks.listTaskLabels(taskId).map((link) => link.labelId),
  );
  const next = new Set(labelIds);
  for (const labelId of current) {
    if (!next.has(labelId)) store.tasks.removeTaskLabel(taskId, labelId);
  }
  for (const labelId of next) {
    if (!current.has(labelId)) store.tasks.addTaskLabel(taskId, labelId);
  }
}

function labelsChanged(
  before: readonly string[],
  after: readonly string[],
): boolean {
  if (before.length !== after.length) return true;
  const afterSet = new Set(after);
  return before.some((labelId) => !afterSet.has(labelId));
}

function labelChangeBody(
  store: TasksApiStore,
  taskId: string,
  authorName: string,
): string {
  const names = store.tasks
    .listLabelsForTask(taskId)
    .map((label) => label.name)
    .sort((left, right) => left.localeCompare(right));
  return names.length === 0
    ? `Labels cleared by ${authorName}`
    : `Labels changed to ${names.join(", ")} by ${authorName}`;
}

function writeSystemComments(
  store: TasksApiStore,
  taskId: string,
  authorName: string,
  bodies: readonly string[],
): void {
  for (const body of bodies) {
    store.tasks.createComment({
      taskId,
      kind: "system",
      authorName,
      body,
    });
  }
}

export interface SeedPromptInput {
  task: StoredTask;
  project: Project;
  subtasks: readonly StoredTask[];
  attachments: readonly Pick<StoredAttachment, "id" | "fileName">[];
  recentComments: readonly StoredComment[];
  presetInstructions: string;
  extraInstructions?: string;
}

function markdownSection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function formatSubtasks(subtasks: readonly StoredTask[]): string {
  if (subtasks.length === 0) return "None.";
  return subtasks
    .map((subtask) => `- ${subtask.key} · ${subtask.title} (${subtask.status})`)
    .join("\n");
}

function formatAttachments(
  attachments: readonly Pick<StoredAttachment, "id" | "fileName">[],
): string {
  if (attachments.length === 0) return "None.";
  return attachments
    .map(
      (attachment) =>
        `- ${attachment.fileName} · ${attachment.id}\n` +
        `  Fetch with: paseo-tasks attachment get ${attachment.id} --out <path>`,
    )
    .join("\n");
}

function formatComments(comments: readonly StoredComment[]): string {
  if (comments.length === 0) return "None.";
  return comments
    .map(
      (comment) =>
        `### ${comment.authorName} · ${comment.kind} · ${comment.createdAt}\n\n${comment.body}`,
    )
    .join("\n\n");
}

export function buildSeedPrompt(input: SeedPromptInput): string {
  const sections = [
    `# ${input.task.key} · ${input.task.title}`,
    markdownSection(
      "Description",
      input.task.description.trim() || "No description provided.",
    ),
    markdownSection(
      "Project context",
      `- Name: ${input.project.name}\n- Linked Paseo project: ${input.project.linkedBbProjectId ?? "Not linked"}`,
    ),
    markdownSection("Sub-tasks", formatSubtasks(input.subtasks)),
    markdownSection("Attachments", formatAttachments(input.attachments)),
    markdownSection("Recent comments", formatComments(input.recentComments)),
    markdownSection(
      "Report-back contract",
      `You are working on task ${input.task.key}. Use the \`paseo-tasks\` CLI (or \`bb tasks\` / MCP \`tasks_*\` tools): comment substantive updates (\`paseo-tasks comment ${input.task.key} --body "..."\`), attach result artifacts, and set status when done (\`paseo-tasks update ${input.task.key} --status in_review\`) or explain any blocker in a comment. Emit \`::task{key="${input.task.key}"}\` on its own line when referencing this task in your reply. Your agent session is already attached to the task.`,
    ),
  ];

  if (input.presetInstructions.trim()) {
    sections.push(
      markdownSection("Preset instructions", input.presetInstructions.trim()),
    );
  }
  if (input.extraInstructions?.trim()) {
    sections.push(
      markdownSection(
        "Additional instructions",
        input.extraInstructions.trim(),
      ),
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export function buildTaskAttachmentContext(
  store: TasksApiStore,
  taskId: string,
): string {
  const task = store.tasks.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const project = store.tasks.getProject(task.projectId);
  if (!project) throw new Error(`Project not found: ${task.projectId}`);

  const labels = store.tasks.listLabelsForTask(task.id);
  const comments = store.tasks
    .listComments(task.id)
    .slice(-RECENT_COMMENT_LIMIT);
  const attachments = [
    ...store.tasks.listAttachmentsForTask(task.id),
    ...store.tasks.listAttachmentsForTaskComments(task.id),
  ];
  const threads = store.tasks.listTaskThreads(task.id);

  return `# ${task.key} · ${task.title}

## Task details

- Status: ${displayName(task.status)}
- Priority: ${displayName(task.priority)}
- Labels: ${labels.length > 0 ? labels.map((label) => label.name).join(", ") : "None"}
- Due: ${task.dueDate ?? "None"}
- Project: ${project.name}

## Description

${task.description.trim() || "No description provided."}

## Sub-tasks

${formatSubtasks(store.tasks.listSubtasks(task.id))}

## Attachments

${formatAttachments(attachments)}

## Last 5 comments

${formatComments(comments)}

## Attached threads

${
  threads.length === 0
    ? "None."
    : threads
        .map(
          (thread) =>
            `- ${thread.threadId} · ${thread.title} · ${displayName(thread.liveStatus)}`,
        )
        .join("\n")
}

## Action contract

You can act on this task with the \`paseo-tasks\` CLI (or MCP \`tasks_*\` tools). If you begin working on it, first run: \`paseo-tasks attach ${task.key}\` (attaches THIS agent so the task shows you as working). Comment substantive updates via \`paseo-tasks comment ${task.key} --body "..."\` and set status via \`paseo-tasks update ${task.key} --status ...\`.
`;
}

function delegatedThreadTitle(task: StoredTask): string {
  const raw = `${task.key} · ${task.title}`;
  return raw.length > MAX_DELEGATED_THREAD_TITLE_WIDTH
    ? `${raw.slice(0, MAX_DELEGATED_THREAD_TITLE_WIDTH - 1)}…`
    : raw;
}

function slugifyBranchPart(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  );
}

function mapPermissionModeToModeId(
  providerId: string,
  permissionMode: Preset["permissionMode"],
): string | undefined {
  const provider = providerId.toLowerCase();
  if (permissionMode === "full") {
    if (provider === "claude") return "bypassPermissions";
    if (provider === "codex") return "full-access";
    return "auto";
  }
  if (permissionMode === "auto") {
    return "auto";
  }
  return undefined;
}

export function mapAgentStatusToLiveStatus(
  status: string | null | undefined,
  archivedAt?: string | null,
): TaskThreadLiveStatus {
  if (archivedAt) return "completed";
  switch (status) {
    case "initializing":
      return "starting";
    case "running":
      return "working";
    case "idle":
      return "idle";
    case "error":
      return "failed";
    case "closed":
      return "completed";
    default:
      return "idle";
  }
}

export async function deliverCommentToLatestAgent(
  paseo: PaseoApi | null,
  store: TasksStore,
  input: {
    taskId: string;
    commentId: string;
    body: string;
    authorName: string;
  },
): Promise<number> {
  if (!paseo) return 0;
  const task = store.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);

  const latestReply = store.getLatestAgentComment(
    input.taskId,
    input.commentId,
  );
  const targetThreadId =
    latestReply?.threadId ??
    store.listTaskThreads(input.taskId)[0]?.threadId ??
    null;
  if (!targetThreadId) return 0;

  const prompt =
    `New comment on task ${task.key} from ${input.authorName}: ${input.body}\n\n` +
    "Treat this as updated context for your work on this task; " +
    `reply via \`paseo-tasks comment ${task.key} --body "..."\` when relevant.`;

  try {
    await paseo.agents.ref(targetThreadId).send(prompt);
    return 1;
  } catch (error) {
    console.warn(
      `Failed to deliver comment ${input.commentId} to agent ${targetThreadId}:`,
      error,
    );
    return 0;
  }
}

export async function createCommentWithDelivery(
  paseo: PaseoApi | null,
  store: TasksApiStore,
  input: {
    taskId: string;
    kind: StoredComment["kind"];
    authorName: string;
    presetName: string | null;
    threadId: string | null;
    body: string;
    notify: boolean;
    awaitDelivery: boolean;
  },
): Promise<StoredComment> {
  const comment = store.transaction(() =>
    store.tasks.createComment({
      taskId: input.taskId,
      kind: input.kind,
      authorName: input.authorName,
      presetName: input.presetName,
      threadId: input.threadId,
      body: input.body,
    }),
  );

  if (!input.notify) return comment;

  const deliver = async (): Promise<StoredComment> => {
    const notifiedCount = await deliverCommentToLatestAgent(paseo, store.tasks, {
      taskId: comment.taskId,
      commentId: comment.id,
      body: comment.body,
      authorName: comment.authorName,
    });
    return store.transaction(() =>
      store.tasks.updateComment(comment.id, { notifiedCount }),
    );
  };

  if (input.awaitDelivery) return deliver();
  void deliver().catch((error) => {
    console.warn(`Failed async comment notification ${comment.id}:`, error);
  });
  return comment;
}

async function lookupPullRequestForCwd(
  cwd: string,
): Promise<Omit<TaskPullRequest, "threadIds"> | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "view",
        "--json",
        "number,title,state,isDraft,url,updatedAt",
      ],
      { cwd, timeout: 4000 },
    );
    const parsed = JSON.parse(stdout) as {
      number?: number;
      title?: string;
      state?: string;
      isDraft?: boolean;
      url?: string;
      updatedAt?: string;
    };
    if (
      typeof parsed.number !== "number" ||
      typeof parsed.url !== "string" ||
      typeof parsed.title !== "string"
    ) {
      return null;
    }
    const rawState = (parsed.state ?? "OPEN").toUpperCase();
    const state: TaskPullRequest["state"] = parsed.isDraft
      ? "draft"
      : rawState === "MERGED"
        ? "merged"
        : rawState === "CLOSED"
          ? "closed"
          : "open";
    return {
      url: parsed.url,
      number: parsed.number,
      title: parsed.title,
      state,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function createDomainHandlers(
  store: TasksApiStore,
  getPaseo: () => PaseoApi | null,
) {
  return {
    createFolder(input: { name: string; parentFolderId?: string | null }) {
      const folder = store.tasks.createFolder(input);
      return { folder };
    },
    renameFolder(input: { folderId: string; name: string }) {
      const folder = store.tasks.updateFolder(input.folderId, {
        name: input.name,
      });
      return { folder };
    },
    moveFolder(input: { folderId: string; parentFolderId: string | null }) {
      const folder = store.tasks.updateFolder(input.folderId, {
        parentFolderId: input.parentFolderId,
      });
      return { folder };
    },
    deleteFolder(input: { folderId: string }) {
      return store.tasks.deleteFolder(input.folderId);
    },
    listFolders() {
      return { folders: store.tasks.listFolders() };
    },
    createProject(input: {
      name: string;
      prefix: string;
      color: string;
      folderId?: string | null;
      linkedBbProjectId?: string | null;
    }) {
      const project = store.tasks.createProject(input);
      return { project };
    },
    updateProject(input: {
      projectId: string;
      name?: string;
      color?: string;
      folderId?: string | null;
      linkedBbProjectId?: string | null;
    }) {
      const { projectId, ...changes } = input;
      const project = store.tasks.updateProject(projectId, changes);
      return { project };
    },
    renameProjectPrefix(input: { projectId: string; prefix: string }) {
      try {
        if (store.projectPrefixExists(input.prefix, input.projectId)) {
          fail(
            "project_prefix_conflict",
            `Project prefix is already in use: ${input.prefix}`,
          );
        }
        const project = store.tasks.updateProject(input.projectId, {
          prefix: input.prefix,
        });
        return { ok: true as const, project };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    async deleteProject(input: { projectId: string; force?: boolean }) {
      try {
        if (!input.force && store.projectTaskCount(input.projectId) > 0) {
          fail(
            "project_not_empty",
            "A project must be empty before it can be deleted; pass force: true to delete its tasks",
          );
        }
        const taskIds = store.tasks
          .listTasks({ projectId: input.projectId })
          .map((task) => task.id);
        const attachments = attachmentsForTasks(store.tasks, taskIds);
        const deleted = store.tasks.deleteProject(input.projectId);
        if (deleted) {
          await removeAttachmentBlobs(store.dataDir, attachments);
        }
        return { ok: true as const, deleted };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    listProjects(input: { folderId?: string | null } = {}) {
      return { projects: store.tasks.listProjects(input.folderId) };
    },
    async listPaseoProjects(paseoOverride?: PaseoApi | null) {
      const paseo = paseoOverride ?? getPaseo();
      if (!paseo) return { bbProjects: [] as PaseoProjectOption[] };
      try {
        const result = await paseo.projects.list();
        return {
          bbProjects: result.projects.map((project) => ({
            id: project.projectId,
            name:
              project.projectCustomName?.trim() ||
              project.projectDisplayName ||
              project.projectRootPath,
            rootPath: project.projectRootPath,
            kind: project.projectKind,
          })),
        };
      } catch {
        return { bbProjects: [] as PaseoProjectOption[] };
      }
    },
    sidebarOpenTaskCount() {
      return { openTaskCount: store.openTaskCount() };
    },
    sidebarSummary() {
      return { projects: store.sidebarSummary() };
    },
    createTask(input: {
      projectId: string;
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: StoredTask["priority"];
      dueDate?: string | null;
      parentTaskId?: string | null;
      labelIds?: string[];
    }) {
      try {
        validateTaskParent(store, input.projectId, input.parentTaskId ?? null);
        validateTaskLabels(store, input.projectId, input.labelIds ?? []);
        const task = store.transaction(() => {
          const created = store.tasks.createTask({
            projectId: input.projectId,
            title: input.title,
            description: input.description ?? "",
            status: input.status ?? "backlog",
            priority: input.priority ?? "none",
            dueDate: input.dueDate ?? null,
            parentTaskId: input.parentTaskId ?? null,
          });
          replaceTaskLabels(store, created.id, input.labelIds ?? []);
          return apiTask(store, created);
        });
        return { ok: true as const, task };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    getTask(input: { taskId: string }) {
      const task = store.tasks.getTask(input.taskId);
      return { task: task ? apiTask(store, task) : null };
    },
    getTaskByKey(input: { taskKey: string }) {
      const task = store.tasks.getTaskByKey(input.taskKey);
      return { task: task ? apiTask(store, task) : null };
    },
    updateTask(input: {
      taskId: string;
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: StoredTask["priority"];
      dueDate?: string | null;
      parentTaskId?: string | null;
      labelIds?: string[];
      authorName?: string;
    }) {
      try {
        const authorName = input.authorName ?? "You";
        const current = store.tasks.getTask(input.taskId);
        if (!current) throw new Error(`Task not found: ${input.taskId}`);
        const parentTaskId =
          input.parentTaskId === undefined
            ? current.parentTaskId
            : input.parentTaskId;
        validateTaskParent(store, current.projectId, parentTaskId, current.id);
        if (input.labelIds) {
          validateTaskLabels(store, current.projectId, input.labelIds);
        }

        const result = store.transaction(() => {
          const beforeLabelIds = store.tasks
            .listTaskLabels(current.id)
            .map((link) => link.labelId);
          const updated = store.tasks.updateTask(current.id, {
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            dueDate: input.dueDate,
            parentTaskId: input.parentTaskId,
          });
          if (input.labelIds) {
            replaceTaskLabels(store, current.id, input.labelIds);
          }

          const bodies: string[] = [];
          if (updated.status !== current.status) {
            bodies.push(
              `Status changed to ${displayName(updated.status)} by ${authorName}`,
            );
          }
          if (updated.priority !== current.priority) {
            bodies.push(
              `Priority changed to ${displayName(updated.priority)} by ${authorName}`,
            );
          }
          if (updated.dueDate !== current.dueDate) {
            bodies.push(
              updated.dueDate === null
                ? `Due date removed by ${authorName}`
                : `Due date changed to ${updated.dueDate} by ${authorName}`,
            );
          }
          if (input.labelIds && labelsChanged(beforeLabelIds, input.labelIds)) {
            bodies.push(labelChangeBody(store, current.id, authorName));
          }
          writeSystemComments(store, current.id, authorName, bodies);
          return apiTask(store, updated);
        });

        return { ok: true as const, task: result };
      } catch (error) {
        if (error instanceof TasksDomainFailure) return taskFailure(error);
        throw error;
      }
    },
    async deleteTask(input: { taskId: string }) {
      const attachments = attachmentsForTasks(store.tasks, [input.taskId]);
      const deleted = store.tasks.deleteTask(input.taskId);
      if (deleted) {
        await removeAttachmentBlobs(store.dataDir, attachments);
      }
      return { deleted };
    },
    listTasks(input: {
      projectId?: string;
      statuses?: TaskStatus[];
      priorities?: StoredTask["priority"][];
      labelIds?: string[];
      activeOnly?: boolean;
      parentTaskId?: string | null;
      search?: string;
      sort?: "manual" | "priority" | "due";
      limit?: number;
      cursor?: string;
    }) {
      const page = store.tasks.listTasksPage({
        projectId: input.projectId,
        statuses: input.statuses,
        priorities: input.priorities,
        labelIds: input.labelIds,
        activeOnly: input.activeOnly,
        parentTaskId: input.parentTaskId,
        search: input.search,
        sort: input.sort,
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        tasks: apiTasks(store, page.tasks),
        nextCursor: page.nextCursor,
      };
    },
    boardMove(input: {
      taskId: string;
      status: TaskStatus;
      beforeTaskId?: string | null;
      afterTaskId?: string | null;
      authorName?: string;
    }) {
      const authorName = input.authorName ?? "You";
      const current = store.tasks.getTask(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      const task = store.transaction(() => {
        const moved = store.tasks.updatePosition(current.id, {
          status: input.status,
          beforeTaskId: input.beforeTaskId,
          afterTaskId: input.afterTaskId,
        });
        if (moved.status !== current.status) {
          writeSystemComments(store, current.id, authorName, [
            `Status changed to ${displayName(moved.status)} by ${authorName}`,
          ]);
        }
        return apiTask(store, moved);
      });
      return { ok: true as const, task };
    },
    moveTaskToProject(input: {
      taskId: string;
      projectId: string;
      authorName?: string;
    }) {
      const authorName = input.authorName ?? "You";
      const current = store.tasks.getTask(input.taskId);
      if (!current) throw new Error(`Task not found: ${input.taskId}`);
      const task = store.transaction(() => {
        const outcome = store.tasks.moveTaskToProject(
          current.id,
          input.projectId,
        );
        for (const { previousKey, task: movedTask } of outcome.moved) {
          writeSystemComments(store, movedTask.id, authorName, [
            `Moved from ${previousKey} to ${movedTask.key} by ${authorName}`,
          ]);
        }
        return apiTask(store, outcome.task);
      });
      return { ok: true as const, task };
    },
    createLabel(input: { projectId: string; name: string; color: string }) {
      return { label: store.tasks.createLabel(input) };
    },
    updateLabel(input: { labelId: string; name?: string; color?: string }) {
      return {
        label: store.tasks.updateLabel(input.labelId, {
          name: input.name,
          color: input.color,
        }),
      };
    },
    deleteLabel(input: { labelId: string }) {
      return { deleted: store.tasks.deleteLabel(input.labelId) };
    },
    listLabels(input: { projectId: string }) {
      return { labels: store.tasks.listLabels(input.projectId) };
    },
    async createComment(
      input: {
        taskId: string;
        body: string;
        notify: boolean;
        kind?: StoredComment["kind"];
        authorName?: string;
        presetName?: string | null;
        threadId?: string | null;
        awaitDelivery?: boolean;
      },
      paseoOverride?: PaseoApi | null,
    ) {
      const comment = await createCommentWithDelivery(
        paseoOverride ?? getPaseo(),
        store,
        {
          taskId: input.taskId,
          kind: input.kind ?? "user",
          authorName: input.authorName ?? "You",
          presetName: input.presetName ?? null,
          threadId: input.threadId ?? null,
          body: input.body,
          notify: input.notify,
          awaitDelivery: input.awaitDelivery ?? false,
        },
      );
      return { comment };
    },
    async listComments(
      input: { taskId: string },
      paseoOverride?: PaseoApi | null,
    ): Promise<{ comments: DisplayComment[] }> {
      const comments = store.tasks.listComments(input.taskId);
      const paseo = paseoOverride ?? getPaseo();
      const agentInfoById = new Map<
        string,
        { title: string | null; provider: CommentProvider | null }
      >();

      if (paseo) {
        const agentIds = new Set<string>();
        for (const comment of comments) {
          if (comment.kind === "agent" && comment.threadId) {
            agentIds.add(comment.threadId);
          }
        }
        if (agentIds.size > 0) {
          try {
            const { entries } = await paseo.agents.list();
            for (const { agent } of entries) {
              if (agentIds.has(agent.id)) {
                agentInfoById.set(agent.id, {
                  title: agent.title,
                  provider: {
                    id: agent.provider,
                    name: displayName(agent.provider),
                  },
                });
              }
            }
          } catch {}
        }
      }

      return {
        comments: comments.map((comment) => {
          const info =
            comment.kind === "agent" && comment.threadId
              ? agentInfoById.get(comment.threadId)
              : undefined;
          return {
            ...comment,
            threadTitle: info?.title ?? null,
            provider: info?.provider ?? null,
          };
        }),
      };
    },
    listAttachments(
      input:
        | { taskId: string }
        | { commentId: string }
        | { commentsOfTaskId: string },
    ) {
      const attachments =
        "taskId" in input
          ? store.tasks.listAttachmentsForTask(input.taskId)
          : "commentId" in input
            ? store.tasks.listAttachmentsForComment(input.commentId)
            : store.tasks.listAttachmentsForTaskComments(
                input.commentsOfTaskId,
              );
      return {
        attachments: attachments.map(attachmentMetadata),
      };
    },
    async uploadAttachment(input: {
      taskId?: string;
      commentId?: string;
      fileName: string;
      mime?: string;
      base64: string;
    }) {
      const bytes = Buffer.from(input.base64, "base64");
      const attachment = await saveAttachmentFromBytes(store.tasks, bytes, {
        taskId: input.taskId,
        commentId: input.commentId,
        fileName: input.fileName,
        mime: input.mime,
        rootDir: store.dataDir,
      });
      return { attachment: attachmentMetadata(attachment) };
    },
    async downloadAttachment(input: { attachmentId: string }) {
      const { attachment, content } = await readAttachmentContent(
        store.tasks,
        input.attachmentId,
        store.dataDir,
      );
      return {
        attachment: attachmentMetadata(attachment),
        base64: content.toString("base64"),
      };
    },
    async deleteAttachment(input: {
      attachmentId: string;
      removeDescriptionReferences?: boolean;
    }) {
      try {
        const attachment = await deleteAttachmentById(
          store.tasks,
          input.attachmentId,
          {
            rootDir: store.dataDir,
            removeDescriptionReferences: input.removeDescriptionReferences,
          },
        );
        return attachment
          ? {
              ok: true as const,
              deleted: true as const,
              attachment: attachmentMetadata(attachment),
            }
          : {
              ok: true as const,
              deleted: false as const,
              attachment: null,
            };
      } catch (error) {
        if (error instanceof AttachmentReferencedError) {
          return {
            ok: false as const,
            error: {
              code: "attachment_referenced" as const,
              message: error.message,
            },
          };
        }
        throw error;
      }
    },
    listTaskThreads(input: { taskId: string }) {
      return { taskThreads: store.tasks.listTaskThreads(input.taskId) };
    },
    async listTaskPullRequests(
      input: { taskId: string },
      paseoOverride?: PaseoApi | null,
    ): Promise<{
      pullRequests: TaskPullRequest[];
      unavailableThreadIds: string[];
    }> {
      const taskThreads = store.tasks.listTaskThreads(input.taskId);
      if (taskThreads.length === 0) {
        return { pullRequests: [], unavailableThreadIds: [] };
      }
      const paseo = paseoOverride ?? getPaseo();
      if (!paseo) {
        return {
          pullRequests: [],
          unavailableThreadIds: taskThreads.map((t) => t.threadId),
        };
      }

      const unavailable: string[] = [];
      const cwds = new Map<string, string[]>();
      try {
        const { entries } = await paseo.agents.list();
        const byId = new Map(entries.map((entry) => [entry.agent.id, entry.agent]));
        for (const tt of taskThreads) {
          const agent = byId.get(tt.threadId);
          if (!agent?.cwd) {
            unavailable.push(tt.threadId);
            continue;
          }
          const list = cwds.get(agent.cwd) ?? [];
          list.push(tt.threadId);
          cwds.set(agent.cwd, list);
        }
      } catch {
        return {
          pullRequests: [],
          unavailableThreadIds: taskThreads.map((t) => t.threadId),
        };
      }

      const byUrl = new Map<string, TaskPullRequest>();
      await Promise.all(
        [...cwds.entries()].map(async ([cwd, threadIds]) => {
          const pr = await lookupPullRequestForCwd(cwd);
          if (!pr) return;
          const existing = byUrl.get(pr.url);
          if (!existing) {
            byUrl.set(pr.url, { ...pr, threadIds: [...threadIds] });
          } else {
            existing.threadIds = [
              ...new Set([...existing.threadIds, ...threadIds]),
            ];
          }
        }),
      );

      return {
        pullRequests: [...byUrl.values()].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt),
        ),
        unavailableThreadIds: unavailable,
      };
    },
    async delegate(
      input: {
        taskId: string;
        presetId: string;
        extraInstructions?: string;
      },
      paseoOverride?: PaseoApi | null,
    ) {
      const paseo = paseoOverride ?? getPaseo();
      if (!paseo) {
        throw new Error(
          "Delegation requires an active Paseo daemon connection.",
        );
      }

      const task = store.tasks.getTask(input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const project = store.tasks.getProject(task.projectId);
      if (!project) throw new Error(`Project not found: ${task.projectId}`);
      const preset = store.tasks.getPreset(input.presetId);
      if (!preset) throw new Error(`Preset not found: ${input.presetId}`);

      const { projects: paseoProjects } = await paseo.projects.list();
      let targetProject = project.linkedBbProjectId
        ? paseoProjects.find(
            (p) =>
              p.projectId === project.linkedBbProjectId ||
              p.projectRootPath === project.linkedBbProjectId ||
              p.projectDisplayName === project.linkedBbProjectId,
          )
        : undefined;

      if (!targetProject && !project.linkedBbProjectId && paseoProjects.length === 1) {
        targetProject = paseoProjects[0];
      }

      if (!targetProject) {
        throw new Error(
          `Task project "${project.name}" (${project.prefix}) is not linked to a Paseo project. Link it in Manage → Projects first.`,
        );
      }

      const comments = store.tasks.listComments(task.id);
      const recentComments = comments.slice(-RECENT_COMMENT_LIMIT);
      const attachments = [
        ...store.tasks.listAttachmentsForTask(task.id),
        ...store.tasks.listAttachmentsForTaskComments(task.id),
      ];
      const title = delegatedThreadTitle(task);
      const prompt = buildSeedPrompt({
        task,
        project,
        subtasks: store.tasks.listSubtasks(task.id),
        attachments,
        recentComments,
        presetInstructions: preset.instructions,
        extraInstructions: input.extraInstructions,
      });

      const useWorktree =
        preset.environmentKind === "new-worktree" &&
        targetProject.projectKind === "git";

      const workspace = await paseo.workspaces.create({
        title,
        source: useWorktree
          ? {
              kind: "worktree",
              cwd: targetProject.projectRootPath,
              projectId: targetProject.projectId,
              action: "branch-off",
              ...(preset.baseBranch ? { baseBranch: preset.baseBranch } : {}),
              worktreeSlug: `${task.key.toLowerCase()}-${slugifyBranchPart(task.title)}`,
            }
          : {
              kind: "directory",
              path: targetProject.projectRootPath,
              projectId: targetProject.projectId,
            },
      });

      const providerSpec = preset.modelId.startsWith(`${preset.providerId}/`)
        ? preset.modelId
        : `${preset.providerId}/${preset.modelId}`;
      const modeId = mapPermissionModeToModeId(
        preset.providerId,
        preset.permissionMode,
      );

      const agent = await workspace.agents.create({
        title,
        prompt,
        labels: {
          taskKey: task.key,
          taskId: task.id,
          taskPreset: preset.name,
        },
        env: {
          PASEO_TASK_KEY: task.key,
          PASEO_TASK_ID: task.id,
          BB_TASK_KEY: task.key,
        },
        config: {
          provider: providerSpec,
          ...(preset.reasoningLevel && preset.reasoningLevel !== "default"
            ? { thinkingOptionId: preset.reasoningLevel }
            : {}),
          ...(modeId ? { modeId } : {}),
          ...(preset.serviceTier === "fast"
            ? { featureValues: { fast_mode: true } }
            : {}),
        },
      });

      store.transaction(() => {
        store.tasks.upsertTaskThread({
          taskId: task.id,
          threadId: agent.id,
          workspaceId: workspace.id,
          presetName: preset.name,
          title,
          liveStatus: "working",
        });

        if (task.status === "backlog" || task.status === "todo") {
          store.tasks.updateTask(task.id, { status: "in_progress" });
          store.tasks.createComment({
            taskId: task.id,
            kind: "system",
            authorName: SYSTEM_AUTHOR_NAME,
            presetName: preset.name,
            threadId: agent.id,
            body: `Status changed to In Progress · dispatched to ${preset.name}`,
          });
        }

        store.tasks.createComment({
          taskId: task.id,
          kind: "system",
          authorName: SYSTEM_AUTHOR_NAME,
          presetName: preset.name,
          threadId: agent.id,
          body: `Dispatched to ${preset.name}`,
        });
      });

      try {
        await agent.timeline.append({
          type: "plugin",
          id: `task-card-${task.id}`,
          kind: TASK_CARD_KIND,
          version: 1,
          data: {
            taskKey: task.key,
            fallbackTitle: task.title,
            valid: true,
            phase: "complete",
          },
        });
      } catch {}

      return { threadId: agent.id, workspaceId: workspace.id };
    },
    async taskThreadsAttach(
      input: { taskId: string; threadId: string },
      paseoOverride?: PaseoApi | null,
    ) {
      const task = store.tasks.getTask(input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const paseo = paseoOverride ?? getPaseo();
      let title = delegatedThreadTitle(task);
      let liveStatus: TaskThreadLiveStatus = "working";
      let workspaceId: string | null = null;

      if (paseo) {
        try {
          const refreshed = await paseo.agents.ref(input.threadId).refresh();
          if (refreshed?.agent) {
            title = refreshed.agent.title?.trim() || title;
            liveStatus = mapAgentStatusToLiveStatus(
              refreshed.agent.status,
              refreshed.agent.archivedAt,
            );
            workspaceId = refreshed.agent.workspaceId ?? null;
          }
        } catch {}
      }

      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: input.threadId,
        workspaceId,
        presetName: MANUAL_PRESET_NAME,
        title,
        liveStatus,
      });

      return { threadId: input.threadId };
    },
    taskThreadsDetach(input: { taskId: string; threadId: string }) {
      const task = store.tasks.getTask(input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const taskThread = store.tasks.getTaskThreadByThreadId(
        task.id,
        input.threadId,
      );
      if (!taskThread) {
        throw new Error(
          `Thread ${input.threadId} is not attached to ${task.key}`,
        );
      }
      store.tasks.deleteTaskThread(taskThread.id);
      return { threadId: taskThread.threadId };
    },
    getAgentTasks(input: { agentId: string }) {
      const links = store.tasks.listTaskThreadsByThreadId(input.agentId);
      const tasks: ApiTask[] = [];
      for (const link of links) {
        const task = store.tasks.getTask(link.taskId);
        if (task) tasks.push(apiTask(store, task));
      }
      return { tasks };
    },
    async searchThreads(
      input: { query: string; limit?: number },
      paseoOverride?: PaseoApi | null,
    ) {
      const paseo = paseoOverride ?? getPaseo();
      if (!paseo) return { threads: [] };
      const limit = Math.min(input.limit ?? 10, 20);
      const q = input.query.trim().toLowerCase();
      try {
        const { entries } = await paseo.agents.list();
        const filtered = entries
          .map((e) => e.agent)
          .filter((agent) => {
            if (!q) return true;
            return (
              agent.id.toLowerCase().includes(q) ||
              (agent.title ?? "").toLowerCase().includes(q)
            );
          })
          .slice(0, limit)
          .map((agent) => ({
            id: agent.id,
            title: agent.title?.trim() || `Agent ${agent.id.slice(0, 8)}`,
            status: agent.status,
            workspaceId: agent.workspaceId,
          }));
        return { threads: filtered };
      } catch {
        return { threads: [] };
      }
    },
    createPreset(input: {
      name: string;
      providerId: string;
      modelId: string;
      reasoningLevel: string;
      serviceTier?: string | null;
      permissionMode: Preset["permissionMode"];
      environmentKind?: Preset["environmentKind"];
      baseBranch?: string | null;
      machineId?: string | null;
      instructions?: string;
    }) {
      const preset = store.tasks.createPreset({
        name: input.name,
        providerId: input.providerId,
        modelId: input.modelId,
        reasoningLevel: input.reasoningLevel,
        serviceTier: input.serviceTier ?? null,
        permissionMode: input.permissionMode,
        environmentKind: input.environmentKind ?? "project-default",
        baseBranch: input.baseBranch ?? null,
        machineId: input.machineId ?? null,
        instructions: input.instructions ?? "",
        builtin: false,
      });
      return { preset };
    },
    updatePreset(input: {
      presetId: string;
      name?: string;
      providerId?: string;
      modelId?: string;
      reasoningLevel?: string;
      serviceTier?: string | null;
      permissionMode?: Preset["permissionMode"];
      environmentKind?: Preset["environmentKind"];
      baseBranch?: string | null;
      machineId?: string | null;
      instructions?: string;
    }) {
      const { presetId, ...changes } = input;
      const preset = store.tasks.updatePreset(
        presetId,
        changes.environmentKind === "project-default"
          ? { ...changes, baseBranch: null, machineId: null }
          : changes,
      );
      return { preset };
    },
    deletePreset(input: { presetId: string }) {
      return { deleted: store.tasks.deletePreset(input.presetId) };
    },
    listPresets() {
      return { presets: store.tasks.listPresets() };
    },
    async listProviderCatalog(paseoOverride?: PaseoApi | null) {
      const paseo = paseoOverride ?? getPaseo();
      if (!paseo) return { providers: [] };
      try {
        const available = await paseo.providers.listAvailable();
        const providers = await Promise.all(
          available.providers.map(async (p) => {
            let models: Array<{ id: string; name: string }> = [];
            if (p.available) {
              try {
                const res = await paseo.providers.listModels(p.provider);
                models = (res.models ?? []).map((m) => ({
                  id: m.id,
                  name: m.label || m.id,
                }));
              } catch {}
            }
            return {
              id: p.provider,
              available: p.available,
              models,
            };
          }),
        );
        return { providers };
      } catch {
        return { providers: [] };
      }
    },
    searchAttachmentItems(input: { query: string }) {
      const normalizedQuery = input.query.trim();
      const search = `%${escapeLike(normalizedQuery)}%`;
      const rows = store.db
        .prepare<
          { search: string },
          {
            id: string;
            key: string;
            title: string;
            project_name: string;
            status: TaskStatus;
          }
        >(
          `
          SELECT
            t.id,
            p.prefix || '-' || t.number AS key,
            t.title,
            p.name AS project_name,
            t.status
          FROM tasks t
          JOIN projects p ON p.id = t.project_id
          WHERE @search = '%%'
            OR (p.prefix || '-' || t.number) LIKE @search ESCAPE '\\'
            OR CAST(t.number AS TEXT) LIKE @search ESCAPE '\\'
            OR t.title LIKE @search ESCAPE '\\'
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT 15
        `,
        )
        .all({ search });

      return {
        items: rows.map((row) => ({
          id: row.id,
          identifier: row.key,
          title: row.title,
          subtitle: `${row.project_name} · ${displayName(row.status)}`,
          url: `https://paseo.sh/tasks/${encodeURIComponent(row.key)}`,
          text: buildTaskAttachmentContext(store, row.id),
          resourceType: "task",
        })),
      };
    },
  };
}

export type TasksDomain = ReturnType<typeof createDomainHandlers>;

function allocatePrefix(
  base: string,
  used: ReadonlySet<string>,
): string | null {
  if (!used.has(base)) return base;
  for (let number = 2; number < 10_000; number += 1) {
    const suffix = String(number);
    const candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

export async function seedDemoData(
  store: TasksApiStore,
  domain: TasksDomain,
  linkedProjectId?: string,
) {
  store.ensureDefaultPresets();

  const existing = domain.listProjects().projects;
  const prefixes = new Set(existing.map((project) => project.prefix));
  const nextPrefix = (base: string) => {
    const allocated = allocatePrefix(base, prefixes);
    if (!allocated) throw new Error(`Could not allocate prefix for ${base}`);
    prefixes.add(allocated);
    return allocated;
  };

  const productFolder = domain.createFolder({ name: "Product" }).folder;
  const lifeFolder = domain.createFolder({ name: "Life" }).folder;

  const projects = [
    domain.createProject({
      name: "Tasks Plugin",
      prefix: nextPrefix("TASKS"),
      color: "blue",
      folderId: productFolder.id,
      linkedBbProjectId: linkedProjectId ?? null,
    }).project,
    domain.createProject({
      name: "Operations",
      prefix: nextPrefix("OPS"),
      color: "orange",
      folderId: productFolder.id,
      linkedBbProjectId: null,
    }).project,
    domain.createProject({
      name: "Personal",
      prefix: nextPrefix("HOME"),
      color: "violet",
      folderId: lifeFolder.id,
      linkedBbProjectId: null,
    }).project,
  ];

  const labelSpecs = [
    [projects[0]!, "Backend", "blue"],
    [projects[0]!, "UX", "violet"],
    [projects[1]!, "Automation", "orange"],
    [projects[1]!, "Blocked", "red"],
    [projects[2]!, "Home", "green"],
    [projects[2]!, "Errand", "yellow"],
  ] as const;

  const labels = labelSpecs.map(
    ([project, name, color]) =>
      domain.createLabel({ projectId: project.id, name, color }).label,
  );

  const mustCreateTask = (input: Parameters<typeof domain.createTask>[0]) => {
    const res = domain.createTask(input);
    if (!res.ok) throw new Error(res.error.message);
    return res.task;
  };

  const taskOne = mustCreateTask({
    projectId: projects[0]!.id,
    title: "Polish the task detail panel",
    description:
      "Finish the detail view, subtasks checklist, and comment notification switch.",
    status: "in_progress",
    priority: "urgent",
    dueDate: "2026-10-24",
    labelIds: [labels[1]!.id],
  });
  const taskTwo = mustCreateTask({
    projectId: projects[0]!.id,
    title: "Add CLI and MCP smoke coverage",
    description:
      "Cover create, list, show, update, comment, and preset delegation.",
    status: "in_review",
    priority: "high",
    labelIds: [labels[0]!.id],
  });
  mustCreateTask({
    projectId: projects[0]!.id,
    title: "Document Paseo project linking",
    status: "todo",
    priority: "medium",
    parentTaskId: taskOne.id,
    labelIds: [labels[0]!.id, labels[1]!.id],
  });
  mustCreateTask({
    projectId: projects[0]!.id,
    title: "Archive the old prototype notes",
    status: "done",
    priority: "low",
  });

  const opsParent = mustCreateTask({
    projectId: projects[1]!.id,
    title: "Prepare the weekly release",
    description: "Coordinate checks, notes, and the rollout window.",
    status: "in_progress",
    priority: "high",
    dueDate: "2026-10-25",
    labelIds: [labels[2]!.id],
  });
  mustCreateTask({
    projectId: projects[1]!.id,
    title: "Confirm CI is green",
    status: "todo",
    priority: "urgent",
    parentTaskId: opsParent.id,
    labelIds: [labels[2]!.id],
  });
  mustCreateTask({
    projectId: projects[1]!.id,
    title: "Rotate staging credentials",
    status: "backlog",
    priority: "medium",
    labelIds: [labels[3]!.id],
  });
  mustCreateTask({
    projectId: projects[1]!.id,
    title: "Publish release notes",
    status: "done",
    priority: "low",
    labelIds: [labels[2]!.id],
  });

  const homeParent = mustCreateTask({
    projectId: projects[2]!.id,
    title: "Plan the weekend reset",
    description: "A short list for getting the house back in shape.",
    status: "todo",
    priority: "medium",
    labelIds: [labels[4]!.id],
  });
  mustCreateTask({
    projectId: projects[2]!.id,
    title: "Pick up groceries",
    status: "todo",
    priority: "high",
    dueDate: "2026-10-20",
    parentTaskId: homeParent.id,
    labelIds: [labels[5]!.id],
  });
  mustCreateTask({
    projectId: projects[2]!.id,
    title: "Repair the hallway shelf",
    status: "backlog",
    priority: "low",
    labelIds: [labels[4]!.id],
  });
  mustCreateTask({
    projectId: projects[2]!.id,
    title: "Book a dentist appointment",
    status: "canceled",
    priority: "none",
    labelIds: [labels[5]!.id],
  });

  const sampleComments = [
    [taskOne.id, "The main layout is ready for a final pass."],
    [taskTwo.id, "Keep JSON output stable for agent callers."],
    [opsParent.id, "Release window is tentatively Friday afternoon."],
    [homeParent.id, "Start with the kitchen and entryway."],
  ] as const;

  for (const [taskId, body] of sampleComments) {
    await domain.createComment({
      taskId,
      body,
      notify: false,
    });
  }

  return {
    foldersCreated: 2,
    projectsCreated: projects.length,
    labelsCreated: labels.length,
    tasksCreated: 12,
    commentsCreated: sampleComments.length,
    linkedBbProjectId: linkedProjectId ?? null,
    projects: projects.map((project) => ({
      id: project.id,
      keyPrefix: project.prefix,
      name: project.name,
    })),
  };
}

const TERMINAL_LIVE_STATUSES = new Set<TaskThreadLiveStatus>(["completed"]);

function statusCommentBody(
  thread: TaskThread,
  liveStatus: Extract<TaskThreadLiveStatus, "completed" | "failed">,
): string {
  const outcome =
    liveStatus === "completed" ? "completed — final message posted" : "failed";
  return `Thread "${thread.title}" ${outcome} · ${thread.threadId}`;
}

export function transitionTrackedThread(
  store: TasksApiStore,
  threadId: string,
  liveStatus: TaskThreadLiveStatus,
): void {
  for (const thread of store.tasks.listTaskThreadsByThreadId(threadId)) {
    if (
      thread.liveStatus === liveStatus ||
      TERMINAL_LIVE_STATUSES.has(thread.liveStatus)
    ) {
      continue;
    }
    store.transaction(() => {
      store.tasks.updateTaskThreadStatus(thread.id, liveStatus);
      if (liveStatus === "completed" || liveStatus === "failed") {
        store.tasks.createComment({
          taskId: thread.taskId,
          kind: "system",
          authorName: SYSTEM_AUTHOR_NAME,
          presetName: thread.presetName,
          threadId: thread.threadId,
          body: statusCommentBody(thread, liveStatus),
        });
      }
    });
  }
}

export function registerLifecycleHooks(
  server: PluginServerContext,
  store: TasksApiStore,
  onPaseoCaptured: (paseo: PaseoApi) => void,
): void {
  server.on("agent.created", ({ agent }, { paseo }) => {
    onPaseoCaptured(paseo);
    transitionTrackedThread(store, agent.id, "starting");
  });

  server.on("agent.turn_started", ({ agent }, { paseo }) => {
    onPaseoCaptured(paseo);
    transitionTrackedThread(store, agent.id, "working");
  });

  server.on("agent.turn_ended", ({ agent, outcome }, { paseo }) => {
    onPaseoCaptured(paseo);
    if (outcome.kind === "failed") {
      transitionTrackedThread(store, agent.id, "failed");
    } else {
      transitionTrackedThread(store, agent.id, "idle");
    }
  });

  server.on("agent.closed", ({ agent }, { paseo }) => {
    onPaseoCaptured(paseo);
    transitionTrackedThread(store, agent.id, "completed");
  });

  server.on("agent.archived", ({ agent }, { paseo }) => {
    onPaseoCaptured(paseo);
    transitionTrackedThread(store, agent.id, "completed");
  });
}
