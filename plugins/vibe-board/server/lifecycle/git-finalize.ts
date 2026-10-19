// Real card-done finalization (WP-20): merge the card's worktree branch into the project's main
// branch, or push it and open a PR with `gh`, then remove the worktree.
//
// Safe by default: never force. It stops (and says why in a card event) when the worktree or the
// main checkout is dirty, the main checkout is not on the target branch, or the merge conflicts
// (the merge is aborted, leaving the checkout as it was). Only fast-forward or a normal merge
// commit is used. The worktree is removed with plain `git worktree remove`; a refusal is only
// reported. The branch is always kept. Before that, the card's live worker/verifier agents are
// archived (their processes hold the directory, which Windows refuses to remove).

import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import type { CardView } from "../vibe/contract";
import type { BoardService } from "../service";
import type { Finalizer } from "./finalize";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Exec = (cwd: string, command: string, args: string[]) => Promise<ExecResult>;

export const nodeExec: Exec = (cwd, command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error?.message ?? "")) });
      },
    );
  });

export type FinalizeMode = "merge" | "pr" | "none";

export interface GitFinalizerOptions {
  board: BoardService;
  exec?: Exec;
  /** SDK handle used to archive the card's agents before the worktree is removed. */
  getPaseo?: () => PaseoApi | null;
  /** How long to wait for one agent to shut down (default 30s). */
  agentCloseTimeoutMs?: number;
  /** Read on every call so settings changes apply immediately. */
  getConfig?: () => Promise<{ mode: FinalizeMode; targetBranch?: string }>;
}

export function createGitFinalizer(options: GitFinalizerOptions): Finalizer {
  const { board } = options;
  const exec = options.exec ?? nodeExec;

  const note = (card: CardView, kind: string, text: string, extra: Record<string, unknown> = {}) =>
    board.store.events.add({
      cardId: card.id,
      type: "status",
      authorKind: "system",
      author: "finalizer",
      body: { kind, text, ...extra },
    });

  /** Archive (= shut down) the card's non-master agents so nothing holds the worktree. */
  async function closeAgents(card: CardView) {
    const sessions = board.store.sessions
      .list({ cardId: card.id })
      .filter((s) => s.role !== "master" && s.state !== "ended");
    const paseo = options.getPaseo?.();
    const failed: string[] = [];
    if (!paseo) return { closed: [] as string[], failed: sessions.map((s) => s.agentId) };
    const closed: string[] = [];
    const timeoutMs = options.agentCloseTimeoutMs ?? 30_000;
    await Promise.all(
      sessions.map(async (s) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            paseo.agents.ref(s.agentId).archive(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
            }),
          ]);
          closed.push(s.agentId);
        } catch {
          failed.push(s.agentId);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return { closed, failed };
  }

  return async (card) => {
    if (!card.worktree) return;
    const config = (await options.getConfig?.()) ?? { mode: "merge" as const };
    const worktree = card.worktree;
    const blocked = (reason: string, text: string) => {
      note(card, "finalize_blocked", text, { reason, worktree });
    };
    if (config.mode === "none") {
      note(card, "finalize_pending", "Finalization is disabled in the settings; merge and clean up manually.", {
        worktree,
      });
      return;
    }

    const project = board.store.projects.list(true).find((p) => p.id === card.projectId);
    if (!project?.repoPath) return blocked("no_repo", "The project has no repository path.");
    const repo = project.repoPath;
    const git = (cwd: string, ...args: string[]) => exec(cwd, "git", args);

    // ---- worktree: clean, on a branch ---------------------------------------------------
    const dirty = await git(worktree, "status", "--porcelain");
    if (dirty.code !== 0) {
      return blocked("worktree_missing", `Cannot read the worktree: ${dirty.stderr.trim()}`);
    }
    if (dirty.stdout.trim()) {
      return blocked(
        "worktree_dirty",
        "The worktree has uncommitted changes; commit or discard them, then merge manually.",
      );
    }
    const branch = (await git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    if (!branch || branch === "HEAD") return blocked("detached", "The worktree is on a detached HEAD.");

    // ---- target branch in the main checkout --------------------------------------------
    const current = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    const target = config.targetBranch || current;
    if (!target || target === "HEAD") return blocked("no_target", "Cannot determine the target branch.");
    if (branch === target) {
      return blocked("same_branch", `The worktree is on the target branch "${target}".`);
    }

    const alreadyMerged = (await git(repo, "merge-base", "--is-ancestor", branch, target)).code === 0;
    let mergeNote = `${branch} was already merged into ${target}`;
    let pr: string | undefined;

    if (config.mode === "merge" && !alreadyMerged) {
      if (current !== target) {
        return blocked(
          "wrong_checkout",
          `The main checkout is on "${current}", not "${target}"; switch it and merge ${branch} manually.`,
        );
      }
      const mainDirty = await git(repo, "status", "--porcelain");
      if (mainDirty.stdout.trim()) {
        return blocked("main_dirty", "The main checkout has uncommitted changes; merge manually.");
      }
      let merge = await git(repo, "merge", "--ff-only", branch);
      let how = "fast-forward";
      if (merge.code !== 0) {
        merge = await git(repo, "merge", "--no-ff", "--no-edit", branch);
        how = "merge commit";
        if (merge.code !== 0) {
          await git(repo, "merge", "--abort");
          return blocked(
            "conflict",
            `Merging ${branch} into ${target} conflicts; it was aborted. Resolve it manually.\n${merge.stdout.trim()}`.trim(),
          );
        }
      }
      mergeNote = `Merged ${branch} into ${target} (${how})`;
    } else if (config.mode === "pr") {
      const push = await git(worktree, "push", "-u", "origin", branch);
      if (push.code !== 0) return blocked("push_failed", `git push failed: ${push.stderr.trim()}`);
      const created = await exec(worktree, "gh", [
        "pr",
        "create",
        "--base",
        target,
        "--head",
        branch,
        "--title",
        `${card.key} ${card.title}`,
        "--body",
        `${card.description || card.title}\n\nCard ${card.key}`,
      ]);
      if (created.code !== 0) {
        return blocked("pr_failed", `gh pr create failed: ${created.stderr.trim()}`);
      }
      pr = created.stdout.trim().split(/\s+/).at(-1);
      mergeNote = `Opened PR for ${branch} into ${target}${pr ? `: ${pr}` : ""}`;
    }

    const agents = await closeAgents(card);
    const mergedCommit = (await git(repo, "rev-parse", target)).stdout.trim();
    const removed = await git(repo, "worktree", "remove", worktree);
    const cleanup =
      removed.code === 0
        ? "worktree removed"
        : `worktree kept (${removed.stderr.trim() || "git refused to remove it"}${
            agents.failed.length ? `; could not shut down agents: ${agents.failed.join(", ")}` : ""
          })`;
    return {
      summary: `${mergeNote}; ${cleanup}; branch ${branch} kept.`,
      detail: {
        mode: config.mode,
        branch,
        target,
        mergedCommit,
        worktreeRemoved: removed.code === 0,
        agentsClosed: agents.closed,
        agentsNotClosed: agents.failed,
        pr,
      },
    };
  };
}
