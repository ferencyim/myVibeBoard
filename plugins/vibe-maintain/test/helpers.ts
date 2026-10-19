import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMaintenanceEngine, type EngineOptions } from "../server/engine";
import { createGitCheck } from "../server/git/check";
import { execGit } from "../server/git/exec";
import type { CardView, Project } from "../server/vibe/contract";
import { createVibeStore, migrateOwner, openVibeDb, readEvents } from "../server/vibe/db";

export const tempDir = (prefix = "vibe-maintain-") => mkdtempSync(join(tmpdir(), prefix));

/** Runs git with a fixed identity; `date` pins author and committer date. */
export function sh(cwd: string, args: string[], date?: string): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
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
  commit(repo, "README.md", "hello\n", "init");
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
  maintenanceCards(): CardView[];
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
  const project = store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: repo, projectType: "other" });
  const engine = createMaintenanceEngine({
    db,
    store,
    now: clock.now,
    git: execGit,
    checks: { git: createGitCheck({ outdated: async () => null }) },
    ...options.engine,
  });
  const complete = (count = 1) => {
    for (let i = 0; i < count; i++) {
      const card = store.cards.create({ projectId: project.id, title: `Task ${i}-${clock.t}` });
      store.cards.move(card.id, { to: "todo", actor: "user" });
      store.cards.dispatch({ cardId: card.id, agentId: `agent-${card.id}`, provider: "claude", worktree: null });
      store.cards.move(card.id, { to: "verifying", actor: "lifecycle" });
      store.cards.move(card.id, { to: "done", actor: "user" });
    }
  };
  return {
    db,
    store,
    clock,
    project,
    repo,
    engine,
    complete,
    events: (type) => readEvents(db, 0, { limit: 5000 }).filter((e) => !type || e.type === type),
    maintenanceCards: () =>
      store.cards.list({ projectId: project.id, includeArchived: true }).filter((c) => c.origin === "maintenance"),
  };
}
