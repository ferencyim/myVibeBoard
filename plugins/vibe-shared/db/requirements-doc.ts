// Read / write a project's requirements document (project.requirementsPath) inside its repository.
// Server only: shells out to git through an injectable Runner. Writes commit exactly that file
// (never pushes) and refuse while the repo is mid merge/rebase/cherry-pick or the path is ignored.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSafeRepoRelativePath } from "../contract/paths";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`; resolves (never rejects) with the exit code. */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolvePromise) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: error && typeof error.code !== "number" ? String(error.message) : String(stderr) });
    });
  });

export type RequirementsDocErrorCode = "invalid_path" | "repo_busy" | "ignored" | "git_failed";

export class RequirementsDocError extends Error {
  readonly code: RequirementsDocErrorCode;
  constructor(code: RequirementsDocErrorCode, message: string) {
    super(message);
    this.name = "RequirementsDocError";
    this.code = code;
  }
}

export interface RequirementsDoc {
  /** Repo-relative path with forward slashes. */
  path: string;
  exists: boolean;
  /** "" when the file does not exist. */
  content: string;
}

export interface WriteRequirementsResult extends RequirementsDoc {
  /** false when the content equals what is already committed (no commit made). */
  committed: boolean;
  commit: string | null;
  /** The file did not exist before this write. */
  created: boolean;
}

/** Validate relPath and resolve it under repoPath; refuses traversal, including through symlinks. */
function resolveDocPath(repoPath: string, relPath: string): { rel: string; abs: string } {
  if (!isSafeRepoRelativePath(relPath))
    throw new RequirementsDocError(
      "invalid_path",
      `Requirements path must be relative to the repository root without "..": ${relPath}`,
    );
  const rel = relPath.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  const root = resolve(repoPath);
  const abs = resolve(root, rel);
  const inside = (p: string, base: string) => {
    const r = relative(base, p);
    return r !== "" && !r.startsWith("..") && !isAbsolute(r);
  };
  if (!inside(abs, root))
    throw new RequirementsDocError("invalid_path", `Path escapes the repository: ${relPath}`);
  // Symlinked directories/files inside the repo must not lead outside it.
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (existsSync(probe)) {
    const real = realpathSync(probe);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !inside(real, realRoot))
      throw new RequirementsDocError("invalid_path", `Path escapes the repository: ${relPath}`);
  }
  return { rel, abs };
}

export function readRequirementsDoc(repoPath: string, relPath: string): RequirementsDoc {
  const { rel, abs } = resolveDocPath(repoPath, relPath);
  if (!existsSync(abs)) return { path: rel, exists: false, content: "" };
  return { path: rel, exists: true, content: readFileSync(abs, "utf8") };
}

const BUSY_MARKERS = [
  ["MERGE_HEAD", "a merge"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
] as const;

async function must(git: GitRunner, repo: string, args: string[]): Promise<GitResult> {
  const r = await git(args, repo);
  if (r.code !== 0)
    throw new RequirementsDocError(
      "git_failed",
      `git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  return r;
}

/**
 * Write `content` (LF line endings) to the requirements file and commit only that file with
 * `message`. Does not push and does not touch other staged changes.
 */
export async function writeRequirementsDoc(
  repoPath: string,
  relPath: string,
  content: string,
  message: string,
  git: GitRunner = execGit,
): Promise<WriteRequirementsResult> {
  const { rel, abs } = resolveDocPath(repoPath, relPath);
  const repo = resolve(repoPath);
  if (!message.trim()) throw new RequirementsDocError("git_failed", "A commit message is required");

  const gitDirOut = (await must(git, repo, ["rev-parse", "--git-dir"])).stdout.trim();
  const gitDir = resolve(repo, gitDirOut);
  for (const [marker, what] of BUSY_MARKERS) {
    if (existsSync(join(gitDir, marker)))
      throw new RequirementsDocError(
        "repo_busy",
        `The repository is in the middle of ${what}; finish or abort it before editing ${rel}`,
      );
  }
  const ignored = await git(["check-ignore", "-q", "--", rel], repo);
  if (ignored.code === 0)
    throw new RequirementsDocError("ignored", `${rel} is ignored by git (.gitignore); it cannot be committed`);
  if (ignored.code !== 1)
    throw new RequirementsDocError("git_failed", `git check-ignore failed: ${ignored.stderr.trim()}`);

  const existed = existsSync(abs);
  const text = content.replaceAll("\r\n", "\n");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");

  const tracked = (await git(["ls-files", "--error-unmatch", "--", rel], repo)).code === 0;
  if (!tracked) await must(git, repo, ["add", "--", rel]);

  const status = (await must(git, repo, ["status", "--porcelain", "--", rel])).stdout.trim();
  if (!status) return { path: rel, exists: true, content: text, committed: false, commit: null, created: !existed };

  await must(git, repo, ["commit", "-m", message, "--", rel]);
  const commit = (await must(git, repo, ["rev-parse", "HEAD"])).stdout.trim();
  return { path: rel, exists: true, content: text, committed: true, commit, created: !existed };
}
