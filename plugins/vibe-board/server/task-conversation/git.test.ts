import { describe, expect, it, vi } from "vitest";
import { createTaskGitFinalizer, type GitExec, type GitState } from "./git";

const base = "a".repeat(40);
const target = "b".repeat(40);
const merged = "c".repeat(40);
const tree = "d".repeat(40);
const other = "e".repeat(40);
const input = { worktree: "/task", repoPath: "/main", verifiedCommit: target };

function fixture() {
  let main = base;
  let remote = base;
  let taskHead = target;
  let taskDirty = false;
  let mainDirty = false;
  let fastForward = true;
  let candidateTree = tree;
  let conflict = false;
  let pushFails = false;
  let mainBranch = "refs/heads/main";
  let treeChanged = false;
  let commonMismatch = false;
  let taskIsMain = false;
  let pushError = "模拟 Git 失败";
  const mutations: string[][] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (code = 1) => ({ code, stdout: "", stderr: "模拟 Git 失败" });
  const revParse = (cwd: string, args: string[]) => {
    if (args.includes("--git-dir"))
      return ok(taskIsMain ? "/repo/.git" : "/repo/.git/worktrees/task");
    if (args.includes("--git-common-dir"))
      return ok(cwd === "/task" && commonMismatch ? "/other/.git" : "/repo/.git");
    if (args.includes("FETCH_HEAD^{commit}")) return ok(remote);
    if (args.includes("HEAD^{commit}")) return ok(cwd === "/task" ? taskHead : main);
    if (args.some((arg) => arg.endsWith("^{tree}")))
      return ok(treeChanged && main === merged ? other : tree);
    throw new Error(`意外 rev-parse：${args.join(" ")}`);
  };
  const ancestor = (args: string[]) => {
    const [older, newer] = args.slice(2);
    if (older === newer || older === base)
      return older === base && newer === target && !fastForward ? fail() : ok();
    if (older === target && newer === merged) return ok();
    return fail();
  };
  const exec: GitExec = vi.fn(async (cwd, command, args) => {
    expect(command).toBe("git");
    switch (args[0]) {
      case "status":
        if (cwd === "/task") return ok(taskDirty ? " M source.ts" : "");
        return ok(mainDirty ? "?? local" : "");
      case "symbolic-ref":
        return ok(mainBranch);
      case "rev-parse":
        return revParse(cwd, args);
      case "fetch":
        return ok();
      case "merge-base":
        return ancestor(args);
      case "merge-tree":
        return conflict ? fail() : ok(candidateTree);
      case "merge":
        mutations.push(args);
        main = fastForward ? target : merged;
        return ok();
      case "ls-remote":
        return ok(`${remote}\trefs/heads/main\n`);
      case "push":
        mutations.push(args);
        if (pushFails) return { code: 1, stdout: "", stderr: pushError };
        remote = main;
        return ok();
      default:
        throw new Error(`意外命令：${args.join(" ")}`);
    }
  });
  return {
    exec,
    mutations,
    set(
      values: Partial<{
        main: string;
        remote: string;
        taskHead: string;
        taskDirty: boolean;
        mainDirty: boolean;
        fastForward: boolean;
        candidateTree: string;
        conflict: boolean;
        pushFails: boolean;
        mainBranch: string;
        treeChanged: boolean;
        commonMismatch: boolean;
        taskIsMain: boolean;
        pushError: string;
      }>,
    ) {
      if (values.main !== undefined) main = values.main;
      if (values.remote !== undefined) remote = values.remote;
      if (values.taskHead !== undefined) taskHead = values.taskHead;
      if (values.taskDirty !== undefined) taskDirty = values.taskDirty;
      if (values.mainDirty !== undefined) mainDirty = values.mainDirty;
      if (values.fastForward !== undefined) fastForward = values.fastForward;
      if (values.candidateTree !== undefined) candidateTree = values.candidateTree;
      if (values.conflict !== undefined) conflict = values.conflict;
      if (values.pushFails !== undefined) pushFails = values.pushFails;
      if (values.mainBranch !== undefined) mainBranch = values.mainBranch;
      if (values.treeChanged !== undefined) treeChanged = values.treeChanged;
      if (values.commonMismatch !== undefined) commonMismatch = values.commonMismatch;
      if (values.taskIsMain !== undefined) taskIsMain = values.taskIsMain;
      if (values.pushError !== undefined) pushError = values.pushError;
    },
  };
}

describe("任务 Git 收尾", () => {
  it("安全 ff 后只 push 完整已验证 commit，并先保存本地结果", async () => {
    const f = fixture();
    const progress: GitState[] = [];
    const finalizer = createTaskGitFinalizer({ exec: f.exec });
    expect(await finalizer.inspectCommit(input.worktree)).toBe(target);
    const result = await finalizer.finalize({
      ...input,
      onProgress: (state) => {
        progress.push(state);
      },
    });
    expect(result).toMatchObject({ status: "completed", localMerged: true, mergedCommit: target });
    expect(progress.map((state) => state.status)).toEqual(["merging", "pending_push", "completed"]);
    expect(f.mutations).toEqual([
      ["merge", "--ff-only", "--no-edit", "-m", "合并已通过验证的任务", target],
      ["push", "origin", `${target}:refs/heads/main`],
    ]);
  });

  it("允许候选树等同已验证代码的普通 merge", async () => {
    const f = fixture();
    f.set({ fastForward: false });
    const result = await createTaskGitFinalizer({ exec: f.exec }).finalize(input);
    expect(result).toMatchObject({ status: "completed", mergedCommit: merged });
    expect(f.mutations[0]).toEqual([
      "merge",
      "--no-ff",
      "--no-edit",
      "-m",
      "合并已通过验证的任务",
      target,
    ]);
  });

  it("普通合并产生新代码时先要求验证，不改 main", async () => {
    const f = fixture();
    f.set({ fastForward: false, candidateTree: other });
    expect(await createTaskGitFinalizer({ exec: f.exec }).finalize(input)).toMatchObject({
      status: "verification_required",
      reason: "merge_needs_verification",
      candidateTree: other,
    });
    expect(f.mutations).toEqual([]);
  });

  it("合并冲突仅报告，不 reset、stash、abort 或移除 worktree", async () => {
    const f = fixture();
    f.set({ fastForward: false, conflict: true });
    expect(await createTaskGitFinalizer({ exec: f.exec }).finalize(input)).toMatchObject({
      status: "blocked",
      reason: "merge_conflict",
    });
    expect(f.mutations).toEqual([]);
  });

  it.each([
    [{ taskDirty: true }, "worktree_dirty"],
    [{ mainDirty: true }, "main_dirty"],
    [{ taskHead: other }, "commit_changed"],
    [{ mainBranch: "refs/heads/feature" }, "wrong_checkout"],
    [{ commonMismatch: true }, "wrong_repository"],
    [{ taskIsMain: true }, "not_worktree"],
    [{ remote: other }, "origin_changed"],
  ] as const)("拒绝不安全状态 %j", async (values, reason) => {
    const f = fixture();
    f.set(values);
    expect(await createTaskGitFinalizer({ exec: f.exec }).finalize(input)).toMatchObject({
      reason,
    });
    expect(f.mutations).toEqual([]);
  });

  it("push 失败持久保留待推状态，重试不重复合并", async () => {
    const f = fixture();
    f.set({ pushFails: true });
    const finalizer = createTaskGitFinalizer({ exec: f.exec });
    const previous = await finalizer.finalize(input);
    expect(previous).toMatchObject({
      status: "pending_push",
      localMerged: true,
      mergedCommit: target,
    });
    f.set({ pushFails: false });
    expect(await finalizer.finalize({ ...input, previous })).toMatchObject({ status: "completed" });
    expect(f.mutations.filter((args) => args[0] === "merge")).toHaveLength(1);
    expect(f.mutations.filter((args) => args[0] === "push")).toHaveLength(2);
  });

  it("拒绝任务目录与项目目录相同，Windows 路径忽略大小写和分隔符", async () => {
    const f = fixture();
    const path = process.platform === "win32" ? "D:\\repo\\main" : "/main";
    const alias = process.platform === "win32" ? "d:/REPO/main/" : "/main/";
    expect(
      await createTaskGitFinalizer({ exec: f.exec }).finalize({
        ...input,
        repoPath: path,
        worktree: alias,
      }),
    ).toMatchObject({ reason: "not_worktree" });
    expect(f.mutations).toEqual([]);
  });

  it("push 失败展示脱敏且截断的 stderr 摘要", async () => {
    const f = fixture();
    f.set({
      pushFails: true,
      pushError:
        "fatal https://alice:password@example.test/repo?access_token=secret denied " +
        "x".repeat(1000),
    });
    const result = await createTaskGitFinalizer({ exec: f.exec }).finalize(input);
    expect(result.message).toContain(
      "fatal https://[凭据已移除]@example.test/repo?access_token=[凭据已移除] denied",
    );
    expect(result.message).not.toContain("alice");
    expect(result.message).not.toContain("password");
    expect(result.message).not.toContain("secret");
    expect(result.message.length).toBeLessThan(700);
  });

  it.each(["target", "remote"] as const)(
    "本地合并后 %s 变化仍保持 pending_push",
    async (change) => {
      const f = fixture();
      const exec: GitExec = async (cwd, command, args) => {
        const result = await f.exec(cwd, command, args);
        if (change === "remote" && args[0] === "ls-remote")
          return { ...result, stdout: `${other}\trefs/heads/main` };
        return result;
      };
      const result = await createTaskGitFinalizer({ exec }).finalize({
        ...input,
        onProgress: (state) => {
          if (change === "target" && state.status === "pending_push") f.set({ mainDirty: true });
        },
      });
      expect(result).toMatchObject({
        status: "pending_push",
        localMerged: true,
        reason: change === "target" ? "target_changed" : "remote_changed",
      });
      expect(f.mutations.filter((args) => args[0] === "push")).toHaveLength(0);
    },
  );

  it.each(["fetch", "merged"] as const)(
    "在 %s 后 Stop 在安全点阻止后续 Git 副作用",
    async (when) => {
      const f = fixture();
      let cancelled = false;
      const exec: GitExec = async (cwd, command, args) => {
        const result = await f.exec(cwd, command, args);
        if (when === "fetch" && args[0] === "fetch") cancelled = true;
        return result;
      };
      const result = await createTaskGitFinalizer({ exec }).finalize({
        ...input,
        isCancelled: () => cancelled,
        onProgress: (state) => {
          if (when === "merged" && state.status === "pending_push") cancelled = true;
        },
      });
      expect(result).toMatchObject({
        reason: "cancelled",
        status: when === "merged" ? "pending_push" : "blocked",
      });
      expect(f.mutations.map((args) => args[0])).toEqual(when === "merged" ? ["merge"] : []);
    },
  );

  it("push 成功但保存回执丢失，重启核对远端后不重复 push", async () => {
    const f = fixture();
    const finalizer = createTaskGitFinalizer({ exec: f.exec });
    let pending: GitState | undefined;
    await finalizer.finalize({
      ...input,
      onProgress: (state) => {
        if (state.status === "pending_push") pending = state;
      },
    });
    expect(await finalizer.finalize({ ...input, previous: pending })).toMatchObject({
      status: "completed",
    });
    expect(f.mutations).toHaveLength(2);
  });

  it("合并后保存失败不 push，重启能发现已合并结果", async () => {
    const f = fixture();
    const finalizer = createTaskGitFinalizer({ exec: f.exec });
    let failOnce = true;
    expect(
      await finalizer.finalize({
        ...input,
        onProgress: (state) => {
          if (state.status === "pending_push" && failOnce) {
            failOnce = false;
            throw new Error("保存失败");
          }
        },
      }),
    ).toMatchObject({ status: "pending_push", reason: "git_check_failed" });
    expect(f.mutations).toHaveLength(1);
    expect(await finalizer.finalize(input)).toMatchObject({ status: "completed" });
    expect(f.mutations.filter((args) => args[0] === "merge")).toHaveLength(1);
  });

  it("复用待推状态时 main 变化立即停止", async () => {
    const f = fixture();
    f.set({ pushFails: true });
    const finalizer = createTaskGitFinalizer({ exec: f.exec });
    const previous = await finalizer.finalize(input);
    f.set({ main: other, pushFails: false });
    expect(await finalizer.finalize({ ...input, previous })).toMatchObject({
      reason: "main_changed",
      localMerged: true,
    });
    expect(f.mutations).toHaveLength(2);
  });

  it("实际 merge 树不同则保留本地已合并状态并拒绝 push", async () => {
    const f = fixture();
    f.set({ fastForward: false, treeChanged: true });
    expect(await createTaskGitFinalizer({ exec: f.exec }).finalize(input)).toMatchObject({
      status: "verification_required",
      reason: "actual_merge_changed",
      localMerged: true,
    });
    expect(f.mutations).toHaveLength(1);
  });

  it("拒绝旧验证状态与无效 commit 参数", async () => {
    const f = fixture();
    const finalizer = createTaskGitFinalizer({ exec: f.exec });
    expect(await finalizer.finalize({ ...input, verifiedCommit: "--all" })).toMatchObject({
      reason: "invalid_commit",
    });
    expect(
      await finalizer.finalize({
        ...input,
        previous: {
          status: "completed",
          verifiedCommit: other,
          localMerged: true,
          message: "旧结果",
        },
      }),
    ).toMatchObject({ reason: "verification_changed" });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("待推重试时检查失败仍保留本地已合并信息", async () => {
    const previous: GitState = {
      status: "pending_push",
      verifiedCommit: target,
      mergedCommit: target,
      localMerged: true,
      message: "等待重试",
    };
    const exec: GitExec = async () => {
      throw new Error("暂时无法读取仓库");
    };
    expect(await createTaskGitFinalizer({ exec }).finalize({ ...input, previous })).toMatchObject({
      status: "pending_push",
      mergedCommit: target,
      localMerged: true,
      reason: "git_check_failed",
    });
  });
});
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

describe("真实隔离仓库 Git 收尾", () => {
  function repository() {
    const home = resolve(
      process.env.TMPDIR ?? "D:/devRepoCaches/r5-114-home",
      "git-finalizer-tests",
    );
    mkdirSync(home, { recursive: true });
    const root = mkdtempSync(join(home, "finalizer-"));
    const main = join(root, "main");
    const origin = join(root, "origin.git");
    const command = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      }).trim();
    command(root, "init", "--bare", "--initial-branch=main", origin);
    command(root, "init", "--initial-branch=main", main);
    command(main, "config", "user.name", "Git Test");
    command(main, "config", "user.email", "git-test@example.invalid");
    writeFileSync(join(main, "base.txt"), "base\n");
    command(main, "add", "base.txt");
    command(main, "commit", "-m", "初始测试提交");
    command(main, "remote", "add", "origin", origin);
    command(main, "push", "origin", "main");
    const worktrees = resolve(
      process.env.VIBE_WORKTREE_ROOT ??
        resolve(import.meta.dirname, "../../../../.dev/wp114-git-test-worktrees"),
      basename(root),
    );
    mkdirSync(worktrees, { recursive: true });
    const first = join(worktrees, "first");
    command(main, "worktree", "add", "-b", "first", first);
    writeFileSync(join(first, "first.txt"), "first\n");
    command(first, "add", "first.txt");
    command(first, "commit", "-m", "第一个任务");
    const firstCommit = command(first, "rev-parse", "HEAD");
    return { root, main, origin, first, firstCommit, command, worktrees };
  }

  it("真实主检出作为任务目录时拒绝，不修改 main 或 origin", async () => {
    const r = repository();
    const before = r.command(r.main, "rev-parse", "HEAD");
    const result = await createTaskGitFinalizer().finalize({
      repoPath: r.main,
      worktree: r.main,
      verifiedCommit: before,
    });
    expect(result).toMatchObject({ status: "blocked", reason: "not_worktree" });
    expect(r.command(r.main, "rev-parse", "HEAD")).toBe(before);
    expect(r.command(r.origin, "rev-parse", "main")).toBe(before);
  });

  it("两个 finalizer 实例按 common-dir 串行完成两个任务的合并与 push", async () => {
    const r = repository();
    const second = join(r.worktrees, "second");
    r.command(r.main, "worktree", "add", "-b", "second", second, r.firstCommit);
    writeFileSync(join(second, "second.txt"), "second\n");
    r.command(second, "add", "second.txt");
    r.command(second, "commit", "-m", "第二个任务");
    const secondCommit = r.command(second, "rev-parse", "HEAD");
    let unlock!: () => void;
    const gate = new Promise<void>((done) => {
      unlock = done;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((done) => {
      entered = done;
    });
    const first = createTaskGitFinalizer().finalize({
      repoPath: r.main,
      worktree: r.first,
      verifiedCommit: r.firstCommit,
      onProgress: async (state) => {
        if (state.status === "merging") {
          entered();
          await gate;
        }
      },
    });
    await firstEntered;
    let secondRead!: () => void;
    const readCommon = new Promise<void>((done) => {
      secondRead = done;
    });
    const calls: string[] = [];
    const exec: GitExec = async (cwd, command, args) => {
      calls.push(args[0]);
      const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
      if (args.includes("--git-common-dir")) secondRead();
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const secondResult = createTaskGitFinalizer({ exec }).finalize({
      repoPath: r.main,
      worktree: second,
      verifiedCommit: secondCommit,
    });
    await readCommon;
    expect(calls).toEqual(["rev-parse"]);
    unlock();
    const results = await Promise.all([first, secondResult]);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(r.command(r.main, "rev-parse", "HEAD")).toBe(secondCommit);
    expect(r.command(r.origin, "rev-parse", "main")).toBe(secondCommit);
  }, 30_000);
});
