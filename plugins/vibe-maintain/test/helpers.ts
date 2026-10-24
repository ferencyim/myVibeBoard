import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaintenanceEngine, type EngineOptions } from "../server/engine";
import { createGitCheck } from "../server/git/check";
import { execGit } from "../server/git/exec";
import type { Project, Task, TaskRoleSnapshot } from "../server/vibe/contract";
import {
  createVibeStore,
  createMaintenanceCommands,
  createTaskRuntimeCommands,
  migrateOwner,
  openVibeDb,
  readEvents,
} from "../server/vibe/db";

export const tempDir = (prefix = "vibe-maintain-") => mkdtempSync(join(tmpdir(), prefix));

/** Keep registered Git worktrees inside the checkout's permitted D: worktree root. */
export function tempWorktreeDir() {
  const root =
    process.env.VIBE_WORKTREE_ROOT?.trim() ||
    (process.platform === "win32"
      ? "D:/devRepoCaches/worktrees"
      : join(tmpdir(), "vibe-worktrees"));
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "maintain-"));
}

/** Runs git with a fixed identity; `date` pins author and committer date. */
export function sh(cwd: string, args: string[], date?: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    },
  );
}

export function write(repo: string, file: string, text: string): void {
  writeFileSync(join(repo, file), text);
}

export function commit(repo: string, file: string, text: string, message: string, date?: string) {
  write(repo, file, text);
  sh(repo, ["add", file]);
  sh(repo, ["commit", "-m", message], date);
}

/** A real repository with one commit on `main`. */
export function makeRepo(prefix = "vibe-maintain-repo-"): string {
  const repo = tempDir(prefix);
  sh(repo, ["init", "-b", "main"]);
  commit(repo, "README.md", "fixture\n", "初始化测试仓库");
  return repo;
}

export class FakeClock {
  constructor(public t: number) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}
export const DAY = 86_400_000;

export interface Harness {
  db: ReturnType<typeof openVibeDb>;
  store: ReturnType<typeof createVibeStore>;
  clock: FakeClock;
  project: Project;
  repo: string;
  engine: ReturnType<typeof createMaintenanceEngine>;
  complete(count?: number): void;
  events(type?: string): ReturnType<typeof readEvents>;
  legacyCardTables(): string[];
  maintenanceTasks(): Task[];
  prompts: string[];
}

/** A confirmed native task plan used by the completion fixtures. */
export const plan = {
  goal: "测试任务",
  approach: "最小修改",
  files: ["file.ts"],
  subtasks: [],
  checks: [{ text: "测试通过", method: "运行单测" }],
};
export const roles = (() => {
  const preset = {
    presetId: "p",
    source: "global" as const,
    models: [{ provider: "codex", model: "test", thinking: "", permissionMode: "auto" as const }],
    environmentKind: "project-default" as const,
    runtimeEnv: null,
    instructions: "",
  };
  return {
    scout: null,
    planner: preset,
    plan_reviewer: null,
    worker: preset,
    subagent: { ...preset, source: "worker" as const },
    reviewer: null,
    verifier: preset,
  } satisfies TaskRoleSnapshot;
})();
export function complete(
  h: Pick<Harness, "store" | "clock" | "db">,
  project: Project,
  count = 1,
): void {
  const runtime = createTaskRuntimeCommands(h.db);
  for (let i = 0; i < count; i++) {
    const workspaceId =
      "completed-" + project.id + "-" + h.clock.t + "-" + i + "-" + h.store.tasks.list().length;
    h.store.tasks.create({ workspaceId, anchorAgentId: "anchor-" + workspaceId });
    runtime.registerSession({
      workspaceId,
      projectId: project.id,
      agentId: "anchor-" + workspaceId,
      role: "planner",
      provider: "codex",
      model: "test",
      candidateIndex: 0,
    });
    h.store.tasks.confirm(workspaceId, { plan, rolesSnapshot: roles });
    for (const phase of ["executing", "verifying", "awaiting_acceptance", "completed"] as const)
      h.store.tasks.setPhase(workspaceId, phase);
  }
}

/** A further project with its own real repository. */
export function addProject(
  h: Pick<Harness, "store">,
  name: string,
  prefix: string,
  options: { yml?: string } = {},
): { project: Project; repo: string } {
  const repo = makeRepo();
  if (options.yml !== undefined) {
    mkdirSync(join(repo, ".vibe"), { recursive: true });
    write(join(repo, ".vibe"), "maintenance.yml", options.yml);
  }
  return {
    project: h.store.projects.create({ name, prefix, repoPath: repo, projectType: "other" }),
    repo,
  };
}

export function setup(
  options: {
    repo?: string;
    start?: number;
    yml?: string;
    engine?: Partial<EngineOptions>;
  } = {},
): Harness {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "core");
  migrateOwner(db, "maintain");
  const clock = new FakeClock(options.start ?? Date.now() - 3_600_000);
  const store = createVibeStore(db, { now: clock.now });
  const repo = options.repo ?? makeRepo();
  if (options.yml !== undefined) {
    mkdirSync(join(repo, ".vibe"), { recursive: true });
    write(join(repo, ".vibe"), "maintenance.yml", options.yml);
  }
  const project = store.projects.create({
    name: "Demo",
    prefix: "DEMO",
    repoPath: repo,
    projectType: "other",
  });
  const prompts: string[] = [];
  const taskLauncher = {
    launch: async ({
      prompt,
      onCreated,
    }: {
      prompt: string;
      onCreated: (task: { workspaceId: string; anchorAgentId: string }) => void;
    }) => {
      const workspaceId = "maintenance-" + store.tasks.list().length;
      const anchorAgentId = "anchor-" + workspaceId;
      store.tasks.create({ workspaceId, anchorAgentId });
      onCreated({ workspaceId, anchorAgentId });
      prompts.push(prompt);
      return { workspaceId, anchorAgentId };
    },
    append: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
    },
  };
  const engine = createMaintenanceEngine({
    db,
    store,
    now: clock.now,
    git: execGit,
    taskLauncher,
    projectIdOfTask: async (workspaceId) =>
      createTaskRuntimeCommands(db).listSessions({ workspaceId })[0]?.projectId ?? undefined,
    checks: { git: createGitCheck({ outdated: async () => null }) },
    ...options.engine,
  });
  return {
    db,
    store,
    clock,
    project,
    repo,
    engine,
    prompts,
    complete: (count = 1) => complete({ store, clock, db }, project, count),
    events: (type) => readEvents(db, 0, { limit: 5000 }).filter((e) => !type || e.type === type),
    maintenanceTasks: () =>
      createMaintenanceCommands(db)
        .links()
        .map((link) => store.tasks.get(link.workspaceId)!)
        .filter(Boolean),
    legacyCardTables: () =>
      db
        .prepare<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('card', 'card_event', 'card_tag')",
        )
        .all()
        .map((row) => row.name),
  };
}
