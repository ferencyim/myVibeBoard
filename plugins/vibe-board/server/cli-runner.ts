import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PRESET_PERMISSION_MODES,
  TASK_KEY_PATTERN,
  TASK_PRIORITIES,
  TASK_SORTS,
  TASK_STATUSES,
  TASKS_PAGE_DEFAULT_LIMIT,
  TASKS_PAGE_MAX_LIMIT,
  ULID_PATTERN,
  type PresetPermissionMode,
  type TaskPriority,
  type TaskSort,
  type TaskStatus,
} from "../shared/constants";
import type {
  Attachment,
  Folder,
  Label,
  Preset,
  Project,
  Task,
} from "../shared/contract";
import { attachmentDownloadUrl } from "./attachments";
import { seedDemoData, type TasksApiStore, type TasksDomain } from "./domain";

export interface CliRunContext {
  cwd?: string;
  threadId?: string;
  projectId?: string;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export class TasksCliError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(
    message: string,
    options?: { code?: string; hint?: string; exitCode?: number },
  ) {
    super(oneLine(message));
    this.name = "TasksCliError";
    this.code = options?.code ?? "cli_error";
    this.hint = options?.hint;
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  emptyMessage: string,
): string {
  if (rows.length === 0) return emptyMessage;
  const normalized = rows.map((row) => row.map(oneLine));
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...normalized.map((row) => (row[index] ?? "").length),
    ),
  );
  const render = (row: readonly string[]) =>
    row
      .map((value, index) =>
        index === row.length - 1
          ? value
          : value.padEnd(widths[index] ?? value.length),
      )
      .join("  ")
      .trimEnd();
  return [render([...headers]), ...normalized.map(render)].join("\n");
}

export function formatDetail(
  fields: readonly (readonly [string, unknown])[],
): string {
  const width = Math.max(...fields.map(([label]) => label.length));
  return fields
    .map(([label, value]) => `${label.padEnd(width)}  ${oneLine(value)}`)
    .join("\n");
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

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

function derivePrefix(name: string, projects: readonly Project[]): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (!base || !/^[A-Z]/u.test(base)) base = `P${base}`;
  base = base.slice(0, 10);
  const prefix = allocatePrefix(
    base,
    new Set(projects.map((project) => project.prefix)),
  );
  if (prefix === null) {
    throw new TasksCliError(`could not derive a unique prefix from ${name}`);
  }
  return prefix;
}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

function parseArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();

  const booleanFlagNames = new Set([
    "json",
    "help",
    "h",
    "yes",
    "notify",
    "active",
    "no-folder",
    "unlink-bb-project",
    "unlink-project",
    "no-due",
    "no-parent",
    "remove-references",
    "clear-service-tier",
  ]);

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      if (eqIndex !== -1) {
        const key = token.slice(2, eqIndex);
        const val = token.slice(eqIndex + 1);
        const list = flags.get(key) ?? [];
        list.push(val);
        flags.set(key, list);
        i += 1;
        continue;
      }
      const key = token.slice(2);
      if (booleanFlagNames.has(key)) {
        booleans.add(key);
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        booleans.add(key);
        i += 1;
        continue;
      }
      const list = flags.get(key) ?? [];
      list.push(next);
      flags.set(key, list);
      i += 2;
      continue;
    }
    if (token === "-h") {
      booleans.add("help");
      i += 1;
      continue;
    }
    if (token === "-o") {
      const next = argv[i + 1];
      if (next !== undefined) {
        const list = flags.get("out") ?? [];
        list.push(next);
        flags.set("out", list);
        i += 2;
        continue;
      }
    }
    positionals.push(token);
    i += 1;
  }

  return { positionals, flags, booleans };
}

function getFlag(
  parsed: ParsedArgs,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const values = parsed.flags.get(name);
    if (values && values.length > 0) return values.at(-1);
  }
  return undefined;
}

function getRepeatableFlag(
  parsed: ParsedArgs,
  ...names: string[]
): string[] {
  const result: string[] = [];
  for (const name of names) {
    const values = parsed.flags.get(name) ?? [];
    for (const val of values) {
      for (const part of val.split(",")) {
        const trimmed = part.trim();
        if (trimmed) result.push(trimmed);
      }
    }
  }
  return result;
}

const HELP_TEXT = `Usage: paseo-tasks <command> [options]

Commands:
  status                              Show the installed Tasks plugin name and version
  project create|list|show|update     Manage tracker projects, prefixes, and Paseo project links
  folder create|list|update|delete    Organize tracker projects into folders
  create                              Create a task (--project, --title, --description, --priority, --due, --label, --parent, --attach)
  list                                List and filter tasks (--project, --status, --priority, --label, --active, --search, --sort, --limit, --cursor)
  show <key-or-id>                    Show full task record, subtasks, comments, attachments, and attached agents
  update <key-or-id>                  Update status, priority, title, description, due date, parent, or labels
  move <key-or-id>                    Move a task and its subtasks to --project
  comment <key-or-id>                 Add a Markdown comment (--body or --body-file, optional --notify)
  attachment add|get|list|remove      Manage task or comment file attachments
  preset list|show|create|update|delete Manage reusable agent execution presets
  delegate <key>                      Start and attach a new Paseo agent using --preset
  attach <key-or-id>                  Attach an agent session (--thread or $PASEO_AGENT_ID) to a task
  detach <key-or-id>                  Detach an agent session from a task
  threads <key>                       List agent sessions attached to a task
  label create|list|delete            Manage project-scoped labels
  seed-demo --yes                     Create sample folders, projects, labels, tasks, and comments

Add --json to any command for machine-readable output.`;

function resolveProject(domain: TasksDomain, address: string): Project {
  const normalized = address.trim().toUpperCase();
  const projects = domain.listProjects().projects;
  const project = projects.find(
    (candidate) =>
      candidate.id === normalized ||
      candidate.prefix === normalized ||
      candidate.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (!project) {
    throw new TasksCliError(`project not found: ${address}`, {
      code: "project_not_found",
    });
  }
  return project;
}

function selectedProject(
  domain: TasksDomain,
  ctx: CliRunContext,
  address: string | undefined,
  required: boolean,
): Project | undefined {
  if (address) return resolveProject(domain, address);
  const projects = domain.listProjects().projects;
  if (ctx.projectId) {
    const linked = projects.filter(
      (p) => p.linkedBbProjectId === ctx.projectId,
    );
    if (linked.length === 1) return linked[0];
  }
  if (projects.length === 1) return projects[0];
  if (required) {
    throw new TasksCliError(
      "missing required option --project; run paseo-tasks project list to see tracker projects",
      { code: "missing_required" },
    );
  }
  return undefined;
}

function resolveFolder(domain: TasksDomain, address: string): Folder {
  const folders = domain.listFolders().folders;
  const normalized = address.trim().toUpperCase();
  const byId = folders.find((f) => f.id === normalized);
  if (byId) return byId;
  const byName = folders.filter(
    (f) => f.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (byName.length === 0) {
    throw new TasksCliError(`folder not found: ${address}`, {
      code: "folder_not_found",
    });
  }
  if (byName.length > 1) {
    throw new TasksCliError(`folder name is ambiguous; use its id: ${address}`, {
      code: "folder_ambiguous",
    });
  }
  return byName[0]!;
}

function resolveTask(domain: TasksDomain, address: string): Task {
  const normalized = address.trim().toUpperCase();
  if (ULID_PATTERN.test(normalized)) {
    const task = domain.getTask({ taskId: normalized }).task;
    if (!task) {
      throw new TasksCliError(`task not found: ${address}`, {
        code: "task_not_found",
      });
    }
    return task;
  }
  if (!TASK_KEY_PATTERN.test(normalized)) {
    throw new TasksCliError(`task not found: ${address}`, {
      code: "task_not_found",
    });
  }
  const task = domain.getTaskByKey({ taskKey: normalized }).task;
  if (!task) {
    throw new TasksCliError(`task not found: ${address}`, {
      code: "task_not_found",
    });
  }
  return task;
}

function resolveLabel(labels: readonly Label[], address: string): Label {
  const normalized = address.trim().toUpperCase();
  const label = labels.find(
    (candidate) =>
      candidate.id === normalized ||
      candidate.name.toLowerCase() === address.trim().toLowerCase(),
  );
  if (!label) {
    throw new TasksCliError(`label not found: ${address}`, {
      code: "label_not_found",
    });
  }
  return label;
}

function resolvePreset(presets: readonly Preset[], address: string): Preset {
  const normalized = address.trim().toLowerCase();
  const matches = presets.filter(
    (p) =>
      p.id.toLowerCase() === normalized || p.name.toLowerCase() === normalized,
  );
  if (matches.length === 0) {
    throw new TasksCliError(`preset not found: ${address}`, {
      code: "preset_not_found",
    });
  }
  return matches[0]!;
}

async function readTextOption(
  cwd: string,
  inline: string | undefined,
  filePath: string | undefined,
): Promise<string | undefined> {
  if (filePath === undefined) return inline;
  const resolved = resolve(cwd, filePath);
  return readFile(resolved, "utf8");
}

function resolveInvokingThreadId(
  explicitThread: string | undefined,
  ctx: CliRunContext,
): string {
  const threadId =
    explicitThread ??
    ctx.threadId ??
    process.env.PASEO_AGENT_ID ??
    process.env.BB_THREAD_ID;
  if (!threadId) {
    throw new TasksCliError(
      "missing --thread and PASEO_AGENT_ID is not set",
      { code: "missing_required" },
    );
  }
  return threadId;
}

export async function runTasksCli(
  argv: readonly string[],
  store: TasksApiStore,
  domain: TasksDomain,
  ctx: CliRunContext = {},
): Promise<CliRunResult> {
  const cleanedArgv =
    argv[0] === "tasks" ? argv.slice(1) : [...argv];
  const parsed = parseArgv(cleanedArgv);
  const wantJson = parsed.booleans.has("json");
  const cwd = ctx.cwd ?? process.env.PASEO_AGENT_CWD ?? process.cwd();
  const invokingThreadId =
    ctx.threadId ?? process.env.PASEO_AGENT_ID ?? process.env.BB_THREAD_ID;

  try {
    if (
      parsed.booleans.has("help") ||
      parsed.positionals.length === 0
    ) {
      return { exitCode: 0, stdout: HELP_TEXT };
    }

    const [cmd0, cmd1, ...restPos] = parsed.positionals;
    const twoWord = `${cmd0} ${cmd1 ?? ""}`.trim();

    if (cmd0 === "status") {
      const payload = { name: "Tasks", version: "0.1.0" };
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(payload)
          : `${payload.name} ${payload.version}`,
      };
    }

    // Project commands
    if (twoWord === "project create") {
      const name = getFlag(parsed, "name");
      if (!name) {
        throw new TasksCliError("missing required option --name", {
          code: "missing_required",
        });
      }
      const projects = domain.listProjects().projects;
      const prefixFlag = getFlag(parsed, "prefix");
      const folderFlag = getFlag(parsed, "folder");
      const folder = folderFlag ? resolveFolder(domain, folderFlag) : undefined;
      const linked =
        getFlag(
          parsed,
          "link-bb-project",
          "bb-project",
          "link-project",
          "paseo-project",
        ) ?? null;
      const color = getFlag(parsed, "color") ?? "blue";
      const result = domain.createProject({
        name,
        prefix: prefixFlag ? prefixFlag.trim().toUpperCase() : derivePrefix(name, projects),
        color,
        folderId: folder?.id ?? null,
        linkedBbProjectId: linked,
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : `Created project ${result.project.prefix}  ${result.project.name}`,
      };
    }

    if (twoWord === "project list") {
      const projects = domain.listProjects().projects;
      const folders = domain.listFolders().folders;
      const folderNames = new Map(folders.map((f) => [f.id, f.name]));
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ projects })
          : formatTable(
              ["PREFIX", "NAME", "FOLDER", "PASEO PROJECT", "ID"],
              projects.map((p) => [
                p.prefix,
                p.name,
                p.folderId ? (folderNames.get(p.folderId) ?? p.folderId) : "-",
                p.linkedBbProjectId ?? "-",
                p.id,
              ]),
              "No projects.",
            ),
      };
    }

    if (twoWord === "project show") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <prefix-or-id>", {
          code: "missing_required",
        });
      }
      const project = resolveProject(domain, target);
      const folder = project.folderId
        ? resolveFolder(domain, project.folderId)
        : null;
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ project, folder })
          : formatDetail([
              ["Project", `${project.prefix} — ${project.name}`],
              ["ID", project.id],
              ["Color", project.color],
              ["Folder", folder?.name ?? "-"],
              ["Paseo project", project.linkedBbProjectId ?? "-"],
              ["Next task", `${project.prefix}-${project.nextTaskNumber}`],
              ["Created", project.createdAt],
            ]),
      };
    }

    if (twoWord === "project update") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <prefix-or-id>", {
          code: "missing_required",
        });
      }
      const project = resolveProject(domain, target);
      const folderFlag = getFlag(parsed, "folder");
      const folder = folderFlag ? resolveFolder(domain, folderFlag) : undefined;
      const renamePrefix = getFlag(parsed, "rename-prefix");
      if (
        renamePrefix &&
        store.projectPrefixExists(renamePrefix.trim().toUpperCase(), project.id)
      ) {
        throw new TasksCliError(
          `Project prefix is already in use: ${renamePrefix.trim().toUpperCase()}`,
        );
      }
      const updated = store.transaction(() =>
        store.tasks.updateProject(project.id, {
          name: getFlag(parsed, "name"),
          color: getFlag(parsed, "color"),
          prefix: renamePrefix ? renamePrefix.trim().toUpperCase() : undefined,
          folderId: parsed.booleans.has("no-folder")
            ? null
            : folder?.id,
          linkedBbProjectId:
            parsed.booleans.has("unlink-bb-project") ||
            parsed.booleans.has("unlink-project")
              ? null
              : getFlag(
                  parsed,
                  "link-bb-project",
                  "bb-project",
                  "link-project",
                  "paseo-project",
                ),
        }),
      );
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ project: updated })
          : `Updated project ${updated.prefix}  ${updated.name}`,
      };
    }

    // Folder commands
    if (twoWord === "folder create") {
      const name = getFlag(parsed, "name");
      if (!name) {
        throw new TasksCliError("missing required option --name", {
          code: "missing_required",
        });
      }
      const parentFlag = getFlag(parsed, "parent");
      const parent = parentFlag ? resolveFolder(domain, parentFlag) : undefined;
      const result = domain.createFolder({
        name,
        parentFolderId: parent?.id ?? null,
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : `Created folder ${result.folder.name}  ${result.folder.id}`,
      };
    }

    if (twoWord === "folder list") {
      const result = domain.listFolders();
      const names = new Map(result.folders.map((f) => [f.id, f.name]));
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : formatTable(
              ["NAME", "PARENT", "ID"],
              result.folders.map((f) => [
                f.name,
                f.parentFolderId
                  ? (names.get(f.parentFolderId) ?? f.parentFolderId)
                  : "-",
                f.id,
              ]),
              "No folders.",
            ),
      };
    }

    if (twoWord === "folder update") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <id-or-name>", {
          code: "missing_required",
        });
      }
      const folder = resolveFolder(domain, target);
      const parentFlag = getFlag(parsed, "parent");
      const noParent = parsed.booleans.has("no-parent");
      const parent = parentFlag ? resolveFolder(domain, parentFlag) : null;
      const updated = store.tasks.updateFolder(folder.id, {
        name: getFlag(parsed, "name"),
        parentFolderId:
          parentFlag === undefined && !noParent ? undefined : (parent?.id ?? null),
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ folder: updated })
          : `Updated folder ${updated.name}  ${updated.id}`,
      };
    }

    if (twoWord === "folder delete") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <id-or-name>", {
          code: "missing_required",
        });
      }
      const folder = resolveFolder(domain, target);
      const result = domain.deleteFolder({ folderId: folder.id });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ ...result, folder })
          : `Deleted folder ${folder.name}`,
      };
    }

    // Task create
    if (cmd0 === "create") {
      const title = getFlag(parsed, "title", "name", "subject");
      if (!title) {
        throw new TasksCliError("missing required option --title", {
          code: "missing_required",
        });
      }
      const project = selectedProject(
        domain,
        ctx,
        getFlag(parsed, "project"),
        true,
      )!;
      const labels = domain.listLabels({ projectId: project.id }).labels;
      const labelIds = getRepeatableFlag(parsed, "label", "labels").map(
        (name) => resolveLabel(labels, name).id,
      );
      const parentFlag = getFlag(parsed, "parent");
      const parent = parentFlag ? resolveTask(domain, parentFlag) : undefined;
      const description =
        (await readTextOption(
          cwd,
          getFlag(parsed, "description", "body", "details", "text", "content"),
          getFlag(parsed, "description-file"),
        )) ?? "";
      const priority = (getFlag(parsed, "priority") ?? "none") as TaskPriority;
      if (!TASK_PRIORITIES.includes(priority)) {
        throw new TasksCliError(
          `invalid priority "${priority}"; expected one of ${TASK_PRIORITIES.join(", ")}`,
        );
      }
      const status = (getFlag(parsed, "status") ?? "backlog") as TaskStatus;
      if (!TASK_STATUSES.includes(status)) {
        throw new TasksCliError(
          `invalid status "${status}"; expected one of ${TASK_STATUSES.join(", ")}`,
        );
      }

      const created = domain.createTask({
        projectId: project.id,
        title,
        description,
        status,
        priority,
        dueDate: getFlag(parsed, "due", "due-date") ?? null,
        parentTaskId: parent?.id ?? null,
        labelIds,
      });
      if (!created.ok) throw new TasksCliError(created.error.message);
      const task = created.task;

      const attachPaths = getRepeatableFlag(
        parsed,
        "attach",
        "file",
        "attachment",
      ).map((p) => resolve(cwd, p));
      const attachments: Attachment[] = [];
      for (const path of attachPaths) {
        const bytes = await readFile(path);
        const uploaded = await domain.uploadAttachment({
          taskId: task.id,
          fileName: path.split(/[\\/]/).at(-1) || "attachment",
          base64: bytes.toString("base64"),
        });
        attachments.push(uploaded.attachment);
      }

      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task, attachments, failedAttachments: [] })
          : [
              `Created ${task.key}  ${task.title}`,
              ...attachments.map(
                (a) => `Attached ${a.fileName}  ${a.id}`,
              ),
            ].join("\n"),
      };
    }

    // Task list
    if (cmd0 === "list") {
      const project = selectedProject(
        domain,
        ctx,
        getFlag(parsed, "project"),
        false,
      );
      const projects = project ? [project] : domain.listProjects().projects;
      const labelById = new Map<string, Label>();
      for (const p of projects) {
        for (const l of domain.listLabels({ projectId: p.id }).labels) {
          labelById.set(l.id, l);
        }
      }
      const labelNames = getRepeatableFlag(parsed, "label", "labels");
      const labelIds = labelNames.map((name) => {
        const matches = [...labelById.values()].filter(
          (l) => l.name.toLowerCase() === name.toLowerCase(),
        );
        if (matches.length === 0) {
          throw new TasksCliError(`label not found: ${name}`, {
            code: "label_not_found",
          });
        }
        return matches[0]!.id;
      });

      const statuses = getRepeatableFlag(
        parsed,
        "status",
        "statuses",
        "state",
      ) as TaskStatus[];
      const priorities = getRepeatableFlag(
        parsed,
        "priority",
        "priorities",
      ) as TaskPriority[];
      const sort = (getFlag(parsed, "sort") ?? "manual") as TaskSort;
      if (!TASK_SORTS.includes(sort)) {
        throw new TasksCliError(
          `invalid sort "${sort}"; expected one of ${TASK_SORTS.join(", ")}`,
        );
      }
      const limitRaw = getFlag(parsed, "limit");
      const limit = limitRaw ? Number(limitRaw) : TASKS_PAGE_DEFAULT_LIMIT;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > TASKS_PAGE_MAX_LIMIT
      ) {
        throw new TasksCliError(
          `limit must be an integer between 1 and ${TASKS_PAGE_MAX_LIMIT}`,
        );
      }

      const result = domain.listTasks({
        projectId: project?.id,
        statuses: statuses.length > 0 ? statuses : undefined,
        priorities: priorities.length > 0 ? priorities : undefined,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
        activeOnly: parsed.booleans.has("active"),
        search: getFlag(parsed, "search", "query", "q"),
        sort,
        limit,
        cursor: getFlag(parsed, "cursor"),
      });

      const enriched = result.tasks.map((task) => {
        const threads = domain.listTaskThreads({ taskId: task.id }).taskThreads;
        return {
          ...task,
          labels: task.labelIds.map((id) => labelById.get(id)?.name ?? id),
          agentsWorking: threads.filter(
            (t) => t.liveStatus === "starting" || t.liveStatus === "working",
          ).length,
        };
      });

      if (wantJson) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            tasks: enriched,
            nextCursor: result.nextCursor,
            limit,
          }),
        };
      }

      const tableText = formatTable(
        ["KEY", "STATUS", "PRIORITY", "DUE", "TITLE", "LABELS", "AGENTS"],
        enriched.map((t) => [
          t.key,
          t.status,
          t.priority,
          t.dueDate ?? "-",
          t.title,
          t.labels.join(", ") || "-",
          t.agentsWorking,
        ]),
        "No tasks.",
      );
      return {
        exitCode: 0,
        stdout:
          result.nextCursor === null
            ? tableText
            : `${tableText}\n\nMore results are available. Re-run with the same filters and add: --limit ${limit} --cursor ${result.nextCursor}`,
      };
    }

    // Task show
    if (cmd0 === "show" || cmd0 === "get") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const project = resolveProject(domain, task.projectId);
      const allLabels = domain.listLabels({ projectId: project.id }).labels;
      const labelById = new Map(allLabels.map((l) => [l.id, l]));
      const labels = task.labelIds
        .map((id) => labelById.get(id)!)
        .filter(Boolean);
      const subtasks = domain.listTasks({
        parentTaskId: task.id,
        limit: TASKS_PAGE_MAX_LIMIT,
      }).tasks;
      const comments = (await domain.listComments({ taskId: task.id }))
        .comments;
      const attachments = [
        ...domain.listAttachments({ taskId: task.id }).attachments,
        ...domain.listAttachments({ commentsOfTaskId: task.id }).attachments,
      ];
      const taskThreads = domain.listTaskThreads({
        taskId: task.id,
      }).taskThreads;
      const { pullRequests, unavailableThreadIds } =
        await domain.listTaskPullRequests({ taskId: task.id });

      if (wantJson) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            task,
            project,
            labels,
            subtasks,
            attachments,
            taskThreads,
            pullRequests,
            pullRequestUnavailableThreadIds: unavailableThreadIds,
            comments,
          }),
        };
      }

      return {
        exitCode: 0,
        stdout: [
          formatDetail([
            ["Task", `${task.key} — ${task.title}`],
            ["ID", task.id],
            ["Project", `${project.prefix} — ${project.name}`],
            ["Status", task.status],
            ["Priority", task.priority],
            ["Due", task.dueDate ?? "-"],
            ["Parent", task.parentTaskId ?? "-"],
            ["Labels", labels.map((l) => l.name).join(", ") || "-"],
            ["Created", task.createdAt],
            ["Updated", task.updatedAt],
          ]),
          `Description\n${task.description || "(none)"}`,
          `Sub-tasks\n${formatTable(
            ["KEY", "STATUS", "PRIORITY", "TITLE"],
            subtasks.map((s) => [s.key, s.status, s.priority, s.title]),
            "(none)",
          )}`,
          `Attachments\n${formatTable(
            ["ID", "NAME", "SIZE"],
            attachments.map((a) => [a.id, a.fileName, formatBytes(a.sizeBytes)]),
            "(none)",
          )}`,
          `Attached threads\n${formatTable(
            ["THREAD", "STATUS", "PRESET", "TITLE"],
            taskThreads.map((t) => [
              t.threadId,
              t.liveStatus,
              t.presetName,
              t.title,
            ]),
            "(none)",
          )}`,
          `Pull requests\n${formatTable(
            ["PR", "STATE", "TITLE", "URL"],
            pullRequests.map((pr) => [
              `#${pr.number}`,
              pr.state,
              pr.title,
              pr.url,
            ]),
            "(none)",
          )}`,
          `Comments\n${formatTable(
            ["TIME", "KIND", "AUTHOR", "PROVIDER", "BODY"],
            comments.map((c) => [
              c.createdAt,
              c.kind,
              c.threadTitle ?? c.authorName,
              c.provider?.name ?? "-",
              c.body,
            ]),
            "(none)",
          )}`,
        ].join("\n\n"),
      };
    }

    // Task update
    if (cmd0 === "update") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const status = getFlag(parsed, "status", "state") as
        | TaskStatus
        | undefined;
      if (status !== undefined && !TASK_STATUSES.includes(status)) {
        throw new TasksCliError(
          `invalid status "${status}"; expected one of ${TASK_STATUSES.join(", ")}`,
        );
      }
      const priority = getFlag(parsed, "priority") as
        | TaskPriority
        | undefined;
      if (priority !== undefined && !TASK_PRIORITIES.includes(priority)) {
        throw new TasksCliError(
          `invalid priority "${priority}"; expected one of ${TASK_PRIORITIES.join(", ")}`,
        );
      }
      const title = getFlag(parsed, "title", "name", "subject");
      const description = await readTextOption(
        cwd,
        getFlag(parsed, "description", "body", "details", "text", "content"),
        getFlag(parsed, "description-file"),
      );
      const due = getFlag(parsed, "due", "due-date");
      const noDue = parsed.booleans.has("no-due");
      const parentFlag = getFlag(parsed, "parent");
      const noParent = parsed.booleans.has("no-parent");
      const parent = parentFlag ? resolveTask(domain, parentFlag) : undefined;

      const labels = domain.listLabels({ projectId: task.projectId }).labels;
      const addLabels = getRepeatableFlag(parsed, "add-label");
      const removeLabels = getRepeatableFlag(parsed, "remove-label");
      const nextLabels = new Set(task.labelIds);
      for (const name of addLabels) {
        nextLabels.add(resolveLabel(labels, name).id);
      }
      for (const name of removeLabels) {
        nextLabels.delete(resolveLabel(labels, name).id);
      }
      const labelsChanged = addLabels.length > 0 || removeLabels.length > 0;

      const updated = domain.updateTask({
        taskId: task.id,
        status,
        priority,
        title,
        description,
        dueDate: noDue ? null : due,
        parentTaskId:
          parentFlag === undefined && !noParent
            ? undefined
            : (parent?.id ?? null),
        labelIds: labelsChanged ? [...nextLabels] : undefined,
        authorName: invokingThreadId ? `agent (${invokingThreadId})` : "cli",
      });
      if (!updated.ok) throw new TasksCliError(updated.error.message);
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task: updated.task })
          : `Updated ${updated.task.key}  ${updated.task.title}`,
      };
    }

    // Task move
    if (cmd0 === "move") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const projectFlag = getFlag(parsed, "project");
      if (!projectFlag) {
        throw new TasksCliError("missing required option --project", {
          code: "missing_required",
        });
      }
      const project = resolveProject(domain, projectFlag);
      const result = domain.moveTaskToProject({
        taskId: task.id,
        projectId: project.id,
        authorName: invokingThreadId ? `agent (${invokingThreadId})` : "cli",
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task: result.task, previousKey: task.key })
          : `Moved ${task.key} to ${result.task.key}  ${result.task.title}`,
      };
    }

    // Comment
    if (cmd0 === "comment") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const body = await readTextOption(
        cwd,
        getFlag(parsed, "body", "message", "text", "content"),
        getFlag(parsed, "body-file"),
      );
      if (!body || !body.trim()) {
        throw new TasksCliError("missing required --body or --body-file", {
          code: "missing_required",
        });
      }
      const author =
        getFlag(parsed, "author") ??
        (invokingThreadId ? `agent (${invokingThreadId})` : "cli");
      const result = await domain.createComment({
        taskId: task.id,
        kind: invokingThreadId ? "agent" : "user",
        authorName: author,
        presetName: null,
        threadId: invokingThreadId ?? null,
        body,
        notify: parsed.booleans.has("notify"),
        awaitDelivery: true,
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : `Commented on ${task.key}  ${result.comment.id}`,
      };
    }

    // Labels
    if (twoWord === "label create") {
      const projectFlag = getFlag(parsed, "project");
      const project = selectedProject(domain, ctx, projectFlag, true)!;
      const name = getFlag(parsed, "name");
      if (!name) {
        throw new TasksCliError("missing required option --name", {
          code: "missing_required",
        });
      }
      const color = getFlag(parsed, "color") ?? "gray";
      const result = domain.createLabel({
        projectId: project.id,
        name,
        color,
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : `Created label ${result.label.name}  ${result.label.id}`,
      };
    }

    if (twoWord === "label list") {
      const project = selectedProject(
        domain,
        ctx,
        getFlag(parsed, "project"),
        true,
      )!;
      const labels = domain.listLabels({ projectId: project.id }).labels;
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ labels })
          : formatTable(
              ["NAME", "COLOR", "ID"],
              labels.map((l) => [l.name, l.color, l.id]),
              "No labels.",
            ),
      };
    }

    if (twoWord === "label delete") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <name-or-id>", {
          code: "missing_required",
        });
      }
      const project = selectedProject(
        domain,
        ctx,
        getFlag(parsed, "project"),
        true,
      )!;
      const label = resolveLabel(
        domain.listLabels({ projectId: project.id }).labels,
        target,
      );
      const result = domain.deleteLabel({ labelId: label.id });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ ...result, label })
          : `Deleted label ${label.name}`,
      };
    }

    // Attachments
    if (twoWord === "attachment add") {
      const ownerAddress = restPos[0];
      if (!ownerAddress) {
        throw new TasksCliError("missing required <key-or-comment-id>", {
          code: "missing_required",
        });
      }
      const fileFlag = getFlag(parsed, "file", "path", "attach");
      if (!fileFlag) {
        throw new TasksCliError("missing required option --file", {
          code: "missing_required",
        });
      }
      const sourcePath = resolve(cwd, fileFlag);
      const bytes = await readFile(sourcePath);
      const normalizedOwner = ownerAddress.trim().toUpperCase();
      const comment = ULID_PATTERN.test(normalizedOwner)
        ? store.tasks.getComment(normalizedOwner)
        : undefined;
      const owner = comment
        ? { commentId: comment.id }
        : { taskId: resolveTask(domain, ownerAddress).id };
      const uploaded = await domain.uploadAttachment({
        ...owner,
        fileName:
          getFlag(parsed, "name") ??
          (sourcePath.split(/[\\/]/).at(-1) || "attachment"),
        base64: bytes.toString("base64"),
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({
              attachment: uploaded.attachment,
              url: attachmentDownloadUrl(uploaded.attachment.id),
            })
          : `Added attachment ${uploaded.attachment.fileName}  ${uploaded.attachment.id}`,
      };
    }

    if (twoWord === "attachment get") {
      const attachmentId = restPos[0];
      if (!attachmentId) {
        throw new TasksCliError("missing required <attachment-id>", {
          code: "missing_required",
        });
      }
      const outFlag = getFlag(parsed, "out", "output", "to");
      if (!outFlag) {
        throw new TasksCliError("missing required option --out", {
          code: "missing_required",
        });
      }
      const outPath = resolve(cwd, outFlag);
      const downloaded = await domain.downloadAttachment({
        attachmentId: attachmentId.trim(),
      });
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, Buffer.from(downloaded.base64, "base64"));
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ attachment: downloaded.attachment, out: outPath })
          : `Saved ${downloaded.attachment.fileName}  ${outPath}`,
      };
    }

    if (twoWord === "attachment list") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const attachments = [
        ...domain.listAttachments({ taskId: task.id }).attachments,
        ...domain.listAttachments({ commentsOfTaskId: task.id }).attachments,
      ];
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task, attachments })
          : formatTable(
              ["ID", "NAME", "TYPE", "SIZE"],
              attachments.map((a) => [
                a.id,
                a.fileName,
                a.mime,
                formatBytes(a.sizeBytes),
              ]),
              "No attachments.",
            ),
      };
    }

    if (twoWord === "attachment remove") {
      const attachmentId = restPos[0];
      if (!attachmentId) {
        throw new TasksCliError("missing required <attachment-id>", {
          code: "missing_required",
        });
      }
      const res = await domain.deleteAttachment({
        attachmentId: attachmentId.trim(),
        removeDescriptionReferences: parsed.booleans.has("remove-references"),
      });
      if (!res.ok) throw new TasksCliError(res.error.message);
      if (!res.deleted) {
        throw new TasksCliError(`attachment not found: ${attachmentId}`, {
          code: "attachment_not_found",
        });
      }
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ deleted: true, attachment: res.attachment })
          : `Removed attachment ${res.attachment.fileName}  ${res.attachment.id}`,
      };
    }

    // Presets
    if (twoWord === "preset list") {
      store.ensureDefaultPresets();
      const presets = domain.listPresets().presets;
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ presets })
          : formatTable(
              [
                "NAME",
                "PROVIDER",
                "MODEL",
                "REASONING",
                "PERMISSION",
                "ENVIRONMENT",
                "BASE BRANCH",
                "ID",
              ],
              presets.map((p) => [
                p.name,
                p.providerId,
                p.modelId,
                p.reasoningLevel,
                p.permissionMode,
                p.environmentKind === "new-worktree"
                  ? "worktree"
                  : "project-default",
                p.baseBranch ?? "-",
                p.id,
              ]),
              "No presets.",
            ),
      };
    }

    if (twoWord === "preset show") {
      store.ensureDefaultPresets();
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <name-or-id>", {
          code: "missing_required",
        });
      }
      const preset = resolvePreset(domain.listPresets().presets, target);
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ preset })
          : formatDetail([
              ["Name", preset.name],
              ["Provider", preset.providerId],
              ["Model", preset.modelId],
              ["Reasoning", preset.reasoningLevel],
              ["Permission", preset.permissionMode],
              [
                "Environment",
                preset.environmentKind === "new-worktree"
                  ? "worktree"
                  : "project-default",
              ],
              ["Base branch", preset.baseBranch ?? "-"],
              ["Instructions", preset.instructions || "-"],
              ["ID", preset.id],
            ]),
      };
    }

    if (twoWord === "preset create") {
      const name = getFlag(parsed, "name");
      const providerId = getFlag(parsed, "provider");
      const modelId = getFlag(parsed, "model");
      const reasoningLevel = getFlag(parsed, "reasoning") ?? "high";
      const permissionMode = (getFlag(parsed, "permission") ??
        "auto") as PresetPermissionMode;
      if (!name || !providerId || !modelId) {
        throw new TasksCliError(
          "missing required options: --name, --provider, --model",
          { code: "missing_required" },
        );
      }
      if (!PRESET_PERMISSION_MODES.includes(permissionMode)) {
        throw new TasksCliError(
          `invalid --permission "${permissionMode}"; expected one of ${PRESET_PERMISSION_MODES.join(", ")}`,
        );
      }
      const envFlag = getFlag(parsed, "environment");
      const environmentKind =
        envFlag === "worktree" || envFlag === "new-worktree"
          ? "new-worktree"
          : "project-default";
      const result = domain.createPreset({
        name,
        providerId,
        modelId,
        reasoningLevel,
        serviceTier: getFlag(parsed, "service-tier") ?? null,
        permissionMode,
        environmentKind,
        baseBranch: getFlag(parsed, "base-branch") ?? null,
        machineId: null,
        instructions: getFlag(parsed, "instructions") ?? "",
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : `Created preset ${result.preset.name}  ${result.preset.id}`,
      };
    }

    if (twoWord === "preset update") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <name-or-id>", {
          code: "missing_required",
        });
      }
      const preset = resolvePreset(domain.listPresets().presets, target);
      const envFlag = getFlag(parsed, "environment");
      const environmentKind =
        envFlag === undefined
          ? undefined
          : envFlag === "worktree" || envFlag === "new-worktree"
            ? ("new-worktree" as const)
            : ("project-default" as const);
      const result = domain.updatePreset({
        presetId: preset.id,
        name: getFlag(parsed, "name"),
        providerId: getFlag(parsed, "provider"),
        modelId: getFlag(parsed, "model"),
        reasoningLevel: getFlag(parsed, "reasoning"),
        permissionMode: getFlag(parsed, "permission") as
          | PresetPermissionMode
          | undefined,
        environmentKind,
        baseBranch: getFlag(parsed, "base-branch"),
        instructions: getFlag(parsed, "instructions"),
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : `Updated preset ${result.preset.name}  ${result.preset.id}`,
      };
    }

    if (twoWord === "preset delete") {
      const target = restPos[0];
      if (!target) {
        throw new TasksCliError("missing required <name-or-id>", {
          code: "missing_required",
        });
      }
      const preset = resolvePreset(domain.listPresets().presets, target);
      const result = domain.deletePreset({ presetId: preset.id });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ ...result, preset })
          : `Deleted preset ${preset.name}`,
      };
    }

    // Delegate / Dispatch
    if (cmd0 === "delegate" || cmd0 === "dispatch") {
      store.ensureDefaultPresets();
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const presetFlag = getFlag(parsed, "preset");
      if (!presetFlag) {
        throw new TasksCliError("missing required option --preset", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const preset = resolvePreset(domain.listPresets().presets, presetFlag);
      const result = await domain.delegate({
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: getFlag(
          parsed,
          "instructions",
          "extra-instructions",
        ),
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task, preset, ...result })
          : result.threadId,
      };
    }

    // Attach / Detach / Threads
    if (cmd0 === "attach") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const threadId = resolveInvokingThreadId(
        getFlag(parsed, "thread", "thread-id"),
        ctx,
      );
      const result = await domain.taskThreadsAttach({
        taskId: task.id,
        threadId,
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task, ...result })
          : `Attached ${result.threadId} to ${task.key}`,
      };
    }

    if (cmd0 === "detach") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const threadId = resolveInvokingThreadId(
        getFlag(parsed, "thread", "thread-id"),
        ctx,
      );
      const result = domain.taskThreadsDetach({
        taskId: task.id,
        threadId,
      });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task, ...result })
          : `Detached ${result.threadId} from ${task.key}`,
      };
    }

    if (cmd0 === "threads") {
      const target = cmd1;
      if (!target) {
        throw new TasksCliError("missing required <key-or-id>", {
          code: "missing_required",
        });
      }
      const task = resolveTask(domain, target);
      const result = domain.listTaskThreads({ taskId: task.id });
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify({ task, taskThreads: result.taskThreads })
          : formatTable(
              ["THREAD", "STATUS", "PRESET", "TITLE"],
              result.taskThreads.map((t) => [
                t.threadId,
                t.liveStatus,
                t.presetName,
                t.title,
              ]),
              "No attached threads.",
            ),
      };
    }

    if (cmd0 === "seed-demo") {
      if (!parsed.booleans.has("yes")) {
        throw new TasksCliError(
          "seed-demo creates sample data; re-run with --yes",
          { code: "confirmation_required" },
        );
      }
      const result = await seedDemoData(store, domain, ctx.projectId);
      return {
        exitCode: 0,
        stdout: wantJson
          ? JSON.stringify(result)
          : formatDetail([
              ["Folders", result.foldersCreated],
              ["Projects", result.projectsCreated],
              ["Labels", result.labelsCreated],
              ["Tasks", result.tasksCreated],
              ["Comments", result.commentsCreated],
              ["Paseo project", result.linkedBbProjectId ?? "-"],
            ]),
      };
    }

    throw new TasksCliError(`unknown command: ${parsed.positionals.join(" ")}`, {
      code: "unknown_command",
      hint: "run paseo-tasks --help for available commands",
    });
  } catch (error) {
    const cliErr =
      error instanceof TasksCliError
        ? error
        : new TasksCliError(
            error instanceof Error ? error.message : String(error),
          );
    if (wantJson) {
      return {
        exitCode: cliErr.exitCode,
        stdout: JSON.stringify({
          ok: false,
          error: {
            code: cliErr.code,
            message: cliErr.message,
            ...(cliErr.hint ? { hint: cliErr.hint } : {}),
          },
        }),
        stderr: cliErr.message,
      };
    }
    return {
      exitCode: cliErr.exitCode,
      stdout: "",
      stderr: cliErr.hint
        ? `Error: ${cliErr.message}\nHint: ${cliErr.hint}`
        : `Error: ${cliErr.message}`,
    };
  }
}
