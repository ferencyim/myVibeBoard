// Where everything lives and who may write it.

import { homedir } from "node:os";
import { join } from "node:path";

export const PROJECT_MEMORY_FILES = [
  "PROJECT_STATE.md",
  "DECISIONS.md",
  "LESSONS.md",
  "INDEX.md",
] as const;
export type ProjectMemoryFile = (typeof PROJECT_MEMORY_FILES)[number];

/** "overwrite": the file holds one current-state entry that is replaced on write. */
export const FILE_POLICY: Record<ProjectMemoryFile, "overwrite" | "append"> = {
  "PROJECT_STATE.md": "overwrite",
  "DECISIONS.md": "append",
  "LESSONS.md": "append",
  "INDEX.md": "append",
};

export type Actor = { role: "master" } | { role: "worker"; agent: string } | { role: "user" };

export class MemoryPermissionError extends Error {}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function assertSafeSegment(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes("..")) {
    throw new MemoryPermissionError(`Unsafe ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A live memory file, as a path relative to `.vibe/` using forward slashes. */
export type MemoryFileRef = ProjectMemoryFile | `workers/${string}/MEMORY.md`;

export const workerFile = (agent: string): MemoryFileRef =>
  `workers/${assertSafeSegment(agent, "agent name")}/MEMORY.md`;

export const archiveFileOf = (file: MemoryFileRef): string => file.replace(/\.md$/, "_ARCHIVE.md");

export function isMemoryFileRef(file: string): file is MemoryFileRef {
  return (
    (PROJECT_MEMORY_FILES as readonly string[]).includes(file) ||
    /^workers\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/MEMORY\.md$/.test(file)
  );
}

/** Project memory: master only. Worker memory: master or that worker. Instructions: user only. */
export function assertCanWrite(actor: Actor, file: MemoryFileRef): void {
  if (!isMemoryFileRef(file)) throw new MemoryPermissionError(`Not a memory file: ${file}`);
  if (actor.role === "master") return;
  if (actor.role === "worker" && file.startsWith("workers/")) {
    if (file === workerFile(actor.agent)) return;
    throw new MemoryPermissionError(`Worker "${actor.agent}" may only write its own MEMORY.md`);
  }
  throw new MemoryPermissionError(`${actor.role} may not write ${file}`);
}

export interface Layout {
  vibeDir: string;
  userDirectives: string;
  instructionsDir: string;
  fileOf(file: string): string;
  sessionJsonl(taskId: string): string;
  sessionMd(taskId: string): string;
}

export function createLayout(projectRoot: string, userHome = join(homedir(), ".vibe")): Layout {
  const vibeDir = join(projectRoot, ".vibe");
  return {
    vibeDir,
    userDirectives: join(userHome, "user", "user_directives.md"),
    instructionsDir: join(vibeDir, "instructions"),
    fileOf: (file) => join(vibeDir, ...file.split("/")),
    sessionJsonl: (id) => join(vibeDir, "sessions", `${assertSafeSegment(id, "task id")}.jsonl`),
    sessionMd: (id) => join(vibeDir, "sessions", `${assertSafeSegment(id, "task id")}.md`),
  };
}
