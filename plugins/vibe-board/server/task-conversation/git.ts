import { execFile } from "node:child_process";
import { resolve } from "node:path";

export interface GitExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type GitExec = (cwd: string, command: string, args: string[]) => Promise<GitExecResult>;

export interface GitState {
  status: "blocked" | "verification_required" | "merging" | "pending_push" | "completed";
  verifiedCommit: string;
  localMerged: boolean;
  mergedCommit?: string;
  mainBefore?: string;
  originCommit?: string;
  candidateTree?: string;
  reason?: string;
  message: string;
}

export interface TaskGitFinalizeInput {
  worktree: string;
  repoPath: string;
  verifiedCommit: string;
  previous?: GitState;
  /** 必须先持久化再返回；保存失败会阻止后续 Git 副作用。 */
  onProgress?: (state: GitState) => Promise<void> | void;
  /** Stop 不等待外部 Git 命令；收尾在下一安全点停止副作用。 */
  isCancelled?: () => boolean;
}

const nodeExec: GitExec = (cwd, command, args) =>
  new Promise((done) => {
    execFile(
      command,
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout, stderr) => {
        let code: number | null = 0;
        if (error) code = typeof error.code === "number" ? error.code : null;
        done({
          code,
          stdout: String(stdout),
          stderr: String(stderr || error?.message || ""),
        });
      },
    );
  });

const isCommit = (value: string) => /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(value);

function pathKey(path: string) {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function errorSummary(message: string) {
  return message
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[凭据已移除]@")
    .replace(/([?&](?:access_token|token|password|secret|auth)=)[^\s&#]+/gi, "$1[凭据已移除]")
    .replace(/(authorization:\s*)(?:[^\r\n]+)/gi, "$1[凭据已移除]")
    .trim()
    .slice(0, 600);
}

// 同一仓库的不同 finalizer 实例也共享锁；等待者在取得锁后重新检查全部状态。
const repositoryLocks = new Map<string, Promise<void>>();
async function withRepositoryLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = repositoryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  repositoryLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (repositoryLocks.get(key) === current) repositoryLocks.delete(key);
  }
}

function initialState(verifiedCommit: string, previous?: GitState): GitState {
  return {
    status: "blocked",
    verifiedCommit,
    localMerged: previous?.localMerged ?? false,
    mergedCommit: previous?.mergedCommit,
    mainBefore: previous?.mainBefore,
    message: "正在检查 Git 收尾条件。",
  };
}

export function createTaskGitFinalizer(options: { exec?: GitExec } = {}) {
  const exec = options.exec ?? nodeExec;
  const git = (cwd: string, ...args: string[]) => exec(cwd, "git", args);
  const read = async (cwd: string, ...args: string[]) => {
    const result = await git(cwd, ...args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Git 检查失败：${args[0]}`);
    return result.stdout.trim();
  };
  const inspectCommit = async (worktree: string) => {
    const commit = await read(worktree, "rev-parse", "--verify", "HEAD^{commit}");
    if (!isCommit(commit)) throw new Error("无法取得任务 worktree 的完整 commit。");
    return commit;
  };
  const isAncestor = async (cwd: string, older: string, newer: string) => {
    const result = await git(cwd, "merge-base", "--is-ancestor", older, newer);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error("无法核对 Git 提交祖先关系。");
  };

  async function inspectSafety({ worktree, repoPath, verifiedCommit }: TaskGitFinalizeInput) {
    const taskCommon = await read(
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const mainCommon = await read(
      repoPath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    const taskGitDir = await read(worktree, "rev-parse", "--path-format=absolute", "--git-dir");
    if (pathKey(taskGitDir) === pathKey(taskCommon) || pathKey(worktree) === pathKey(repoPath)) {
      return {
        reason: "not_worktree",
        message: "任务目录必须是独立的附加 Git worktree，不能使用项目主检出。",
      };
    }
    if (pathKey(taskCommon) !== pathKey(mainCommon)) {
      return { reason: "wrong_repository", message: "任务 worktree 与项目 main 不属于同一仓库。" };
    }
    if (await read(worktree, "status", "--porcelain", "--untracked-files=all")) {
      return {
        reason: "worktree_dirty",
        message: "任务 worktree 有未提交改动，请先收口并重新验证。",
      };
    }
    if ((await inspectCommit(worktree)) !== verifiedCommit) {
      return {
        reason: "commit_changed",
        message: "任务 HEAD 已变化，请重新验证并通过。",
        verification: true,
      };
    }
    if ((await read(repoPath, "symbolic-ref", "--quiet", "HEAD")) !== "refs/heads/main") {
      return { reason: "wrong_checkout", message: "项目主检出必须位于 main 分支。" };
    }
    if (await read(repoPath, "status", "--porcelain", "--untracked-files=all")) {
      return { reason: "main_dirty", message: "项目 main 有未提交改动，Git 收尾已停止。" };
    }
    return undefined;
  }

  const unchanged = async (input: TaskGitFinalizeInput, main: string) =>
    (await inspectCommit(input.repoPath)) === main && !(await inspectSafety(input));

  async function prepareMerge(
    repoPath: string,
    main: string,
    verifiedCommit: string,
    targetTree: string,
  ): Promise<
    | { mode: "--ff-only" | "--no-ff"; candidateTree?: string }
    | { reason: string; message: string; verification?: boolean; candidateTree?: string }
  > {
    if (await isAncestor(repoPath, main, verifiedCommit)) return { mode: "--ff-only" };
    const candidate = await git(repoPath, "merge-tree", "--write-tree", main, verifiedCommit);
    if (candidate.code !== 0)
      return {
        reason: "merge_conflict",
        message: "合并预检失败或存在冲突；未修改 main，请人工处理。",
      };
    const candidateTree = candidate.stdout.trim().split(/\s+/)[0];
    if (candidateTree !== targetTree)
      return {
        reason: "merge_needs_verification",
        message: "合并结果包含未验证代码，请在任务 worktree 收口合并结果，重新验证并通过。",
        verification: true,
        candidateTree,
      };
    return { mode: "--no-ff", candidateTree };
  }

  // Git 检查与副作用必须按顺序执行，保留同一状态闭包便于审查安全点。
  // oxlint-disable-next-line complexity
  async function finalizeLocked(input: TaskGitFinalizeInput): Promise<GitState> {
    const { worktree, repoPath, verifiedCommit, previous, onProgress } = input;
    let state = initialState(verifiedCommit, previous);
    const save = async (patch: Partial<GitState>): Promise<GitState> => {
      state = { ...state, ...patch };
      await onProgress?.({ ...state });
      return state;
    };
    const stop = (reason: string, message: string, verification = false) =>
      save({ status: verification ? "verification_required" : "blocked", reason, message });
    const cancelled = () =>
      save({
        status: state.localMerged ? "pending_push" : "blocked",
        reason: "cancelled",
        message: state.localMerged
          ? "已停止 Git 收尾；本地已合并，保留待推状态。"
          : "已停止 Git 收尾。",
      });
    if (!isCommit(verifiedCommit)) return stop("invalid_commit", "缺少本轮已验证的完整 commit。");
    if (previous && previous.verifiedCommit !== verifiedCommit) {
      return stop("verification_changed", "本轮验证 commit 已变化，需重新验证并通过。");
    }

    // 读取失败也必须停止，不能把 Git 错误当作干净树或不存在的远端。
    try {
      if (input.isCancelled?.()) return cancelled();
      const unsafe = await inspectSafety(input);
      if (unsafe) return stop(unsafe.reason, unsafe.message, unsafe.verification);
      if (input.isCancelled?.()) return cancelled();
      // 不更新工作区和分支；只取远端对象，使用本次 FETCH_HEAD，避免陈旧 tracking ref。
      await read(repoPath, "fetch", "--no-tags", "origin", "refs/heads/main");
      if (input.isCancelled?.()) return cancelled();
      const originCommit = await read(repoPath, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
      const main = await inspectCommit(repoPath);
      const targetTree = await read(worktree, "rev-parse", `${verifiedCommit}^{tree}`);
      state = { ...state, originCommit, mainBefore: previous?.mainBefore ?? main };
      if (previous?.localMerged) {
        state = { ...state, localMerged: true, mergedCommit: previous.mergedCommit };
        if (main !== previous.mergedCommit) {
          return stop("main_changed", "本地已合并，但 main 随后发生变化；请重新检查和验证。");
        }
      }
      if (!(await isAncestor(repoPath, originCommit, main))) {
        return stop(
          "origin_changed",
          "origin main 有本地未包含的新提交，请先验证合并结果并重新通过。",
          true,
        );
      }
      const alreadyMerged = await isAncestor(repoPath, verifiedCommit, main);
      if (alreadyMerged) {
        if ((await read(repoPath, "rev-parse", `${main}^{tree}`)) !== targetTree) {
          return stop(
            "merged_tree_changed",
            "main 的代码超出本轮已验证内容，需重新验证并通过。",
            true,
          );
        }
        await save({
          status: "pending_push",
          localMerged: true,
          mergedCommit: main,
          message: "本地 main 已包含已验证代码，正在核对远端。",
        });
      } else {
        const merge = await prepareMerge(repoPath, main, verifiedCommit, targetTree);
        state = { ...state, candidateTree: merge.candidateTree };
        if ("reason" in merge) return stop(merge.reason, merge.message, merge.verification);
        await save({
          status: "merging",
          reason: undefined,
          message: "即将把已验证代码安全合入本地 main。",
        });
        if (!(await unchanged(input, main))) {
          return stop("target_changed", "Git 收尾前仓库状态发生变化，已停止。");
        }
        if (input.isCancelled?.()) return cancelled();
        const merged = await git(
          repoPath,
          "merge",
          merge.mode,
          "--no-edit",
          "-m",
          "合并已通过验证的任务",
          verifiedCommit,
        );
        if (merged.code !== 0)
          return stop("merge_failed", "Git 合并失败，已保留现场；请检查冲突，不会自动处理。");
        const mergedCommit = await inspectCommit(repoPath);
        await save({
          status: "pending_push",
          localMerged: true,
          mergedCommit,
          message: "已合入本地 main，等待 push。",
        });
        if ((await read(repoPath, "rev-parse", `${mergedCommit}^{tree}`)) !== targetTree) {
          return stop(
            "actual_merge_changed",
            "实际合并结果与已验证代码不同，需重新验证并通过。",
            true,
          );
        }
      }
      if (input.isCancelled?.()) return cancelled();
      return await pushVerified(input, state, save);
    } catch (error) {
      // 持久化失败不能吞掉后继续 Git；此处只报告失败，不做任何补偿写操作。
      return save({
        status: state.localMerged ? "pending_push" : "blocked",
        reason: "git_check_failed",
        message: `Git 收尾停止：${errorSummary(error instanceof Error ? error.message : String(error))}`,
      });
    }
  }

  async function pushVerified(
    input: TaskGitFinalizeInput,
    state: GitState,
    save: (patch: Partial<GitState>) => Promise<GitState>,
  ) {
    const { repoPath } = input;
    const stop = (reason: string, message: string) =>
      save({ status: "pending_push", reason, message });
    if (!state.mergedCommit || !(await unchanged(input, state.mergedCommit))) {
      return stop("target_changed", "push 前仓库状态发生变化，已停止。");
    }
    const remote = await read(repoPath, "ls-remote", "--exit-code", "origin", "refs/heads/main");
    const remoteCommit = remote.split(/\s+/)[0];
    if (remoteCommit !== state.mergedCommit) {
      if (remoteCommit !== state.originCommit)
        return stop("remote_changed", "push 前 origin main 已变化，请重新检查并通过。");
      if (input.isCancelled?.())
        return stop("cancelled", "已停止 Git 收尾；本地已合并，保留待推状态。");
      // 显式 commit refspec，避免并发移动 main 后误推未经验证的新 HEAD；绝不用 force。
      const push = await git(repoPath, "push", "origin", `${state.mergedCommit}:refs/heads/main`);
      if (push.code !== 0)
        return save({
          status: "pending_push",
          reason: "push_failed",
          message: `本地已合并，push 未成功；可重试，不会重复合并。${push.stderr.trim() ? "\n" + errorSummary(push.stderr) : ""}`,
        });
    }
    const published = await read(repoPath, "ls-remote", "--exit-code", "origin", "refs/heads/main");
    if (published.split(/\s+/)[0] !== state.mergedCommit) {
      return save({
        status: "pending_push",
        reason: "push_unconfirmed",
        message: "远端结果尚未确认，保留本地已合并状态，请重试核对。",
      });
    }
    return save({
      status: "completed",
      reason: undefined,
      message: "已合入本地 main 并 push origin main；任务 workspace 和会话保留。",
    });
  }

  async function finalize(input: TaskGitFinalizeInput): Promise<GitState> {
    if (
      !isCommit(input.verifiedCommit) ||
      (input.previous && input.previous.verifiedCommit !== input.verifiedCommit)
    )
      return finalizeLocked(input);
    let common: string;
    try {
      common = await read(
        input.worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      );
    } catch (error) {
      const state: GitState = {
        ...initialState(input.verifiedCommit, input.previous),
        status: input.previous?.localMerged ? "pending_push" : "blocked",
        reason: "git_check_failed",
        message: `Git 收尾停止：${errorSummary(error instanceof Error ? error.message : String(error))}`,
      };
      await input.onProgress?.(state);
      return state;
    }
    return withRepositoryLock(pathKey(common), () => finalizeLocked(input));
  }

  return { inspectCommit, finalize };
}
