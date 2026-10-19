// Providers without a system-prompt channel read the generated block from an AGENTS file in the
// working directory. The block lives between markers and is rewritten on every agent start.
// The file change must never reach the executing agent's commits: AGENTS.override.md (Codex
// prefers it over AGENTS.md) is git-excluded; a tracked AGENTS.md is skip-worktree'd, and only in
// a linked worktree (never alter a user's main checkout).

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONTEXT_END, CONTEXT_START } from "./content";

export type AgentsTarget = "AGENTS.md" | "AGENTS.override.md";

export interface GitResult {
  code: number;
  stdout: string;
}
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((done) => {
    execFile("git", args, { cwd, windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ code, stdout: String(stdout) });
    });
  });

export function removeBlock(text: string): string {
  const start = text.indexOf(CONTEXT_START);
  const end = text.indexOf(CONTEXT_END);
  if (start < 0 || end < start) return text;
  const head = text.slice(0, start).replace(/\s+$/, "");
  const tail = text.slice(end + CONTEXT_END.length).replace(/^\s+/, "");
  return [head, tail].filter(Boolean).join("\n\n");
}

/** Insert or refresh `block` at the end of `existing`. Idempotent. */
export function applyBlock(existing: string, block: string): string {
  const base = removeBlock(existing);
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

const readIfExists = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

export interface InstallResult {
  written: boolean;
  file: string;
  /** Why nothing was written, or how the file was hidden from git. */
  note: string;
}

async function isLinkedWorktree(cwd: string, git: GitRunner): Promise<boolean | null> {
  const dir = await git(["rev-parse", "--git-dir"], cwd);
  const common = await git(["rev-parse", "--git-common-dir"], cwd);
  if (dir.code || common.code) return null;
  return resolve(cwd, dir.stdout.trim()) !== resolve(cwd, common.stdout.trim());
}

async function excludeFile(cwd: string, name: string, git: GitRunner): Promise<void> {
  const out = await git(["rev-parse", "--git-path", "info/exclude"], cwd);
  if (out.code) return;
  const path = resolve(cwd, out.stdout.trim());
  const text = readIfExists(path);
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(name) || lines.includes(`/${name}`)) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}/${name}\n`);
}

export async function installAgentsBlock(input: {
  cwd: string;
  block: string;
  target: AgentsTarget;
  git?: GitRunner;
}): Promise<InstallResult> {
  const { cwd, block, target } = input;
  const git = input.git ?? runGit;
  const file = join(cwd, target);
  const tracked = (await git(["ls-files", "--error-unmatch", "--", target], cwd)).code === 0;

  if (target === "AGENTS.md" && tracked) {
    if ((await isLinkedWorktree(cwd, git)) !== true) {
      return { written: false, file, note: "tracked AGENTS.md outside a linked worktree: left untouched" };
    }
    writeFileSync(file, applyBlock(readIfExists(file), block));
    await git(["update-index", "--skip-worktree", "--", target], cwd);
    return { written: true, file, note: "tracked AGENTS.md marked skip-worktree" };
  }

  // Codex reads AGENTS.override.md instead of AGENTS.md, so a fresh override carries both.
  const base =
    target === "AGENTS.override.md" && !existsSync(file)
      ? readIfExists(join(cwd, "AGENTS.md"))
      : readIfExists(file);
  writeFileSync(file, applyBlock(base, block));
  await excludeFile(cwd, target, git);
  return { written: true, file, note: "excluded via .git/info/exclude" };
}
