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
  const mutations: string[][] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (code = 1) => ({ code, stdout: "", stderr: "模拟 Git 失败" });
  const revParse = (cwd: string, args: string[]) => {
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
        if (pushFails) return fail();
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
