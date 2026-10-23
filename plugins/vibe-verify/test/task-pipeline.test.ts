import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskPipeline, taskTree, verificationBaselineRoot } from "../server/task-pipeline";
import { createTaskVerifyStore } from "../server/task-store";
import { createVerifyStore } from "../server/store";
import { writeArtifact } from "../server/collectors/common";
import { DEFAULT_TUNING } from "../server/tuning";
import {
  createCollectorRegistry,
  createScriptedRunner,
  resolveTaskRoles,
  type Judgement,
} from "../server/vibe/contract";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import type { VerifierLauncher } from "../server/verifier/agent";

const databases: ReturnType<typeof openVibeDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(
  options: {
    judgement?: Judgement;
    review?: "pass" | "severe";
    busy?: boolean;
    dirty?: boolean;
    headChanges?: boolean;
    closeFails?: boolean;
    noEvidence?: boolean;
    maxReturns?: number;
    duplicate?: boolean;
    stop?: boolean;
    perf?: boolean;
  } = {},
) {
  const db = openVibeDb({ path: ":memory:" });
  databases.push(db);
  migrateOwner(db, "verify");
  const board = createVibeStore(db);
  const root = mkdtempSync(join(tmpdir(), "vibe-task-verify-"));
  const worktree = mkdtempSync(join(tmpdir(), "vibe-task-worktree-"));
  const project = board.projects.create({
    name: "验证测试",
    prefix: "VT",
    repoPath: worktree,
    projectType: "backend",
  });
  const preset = board.presets.create({ name: "冻结模型", provider: "codex", model: "model-one" });
  const roles = resolveTaskRoles(
    {},
    null,
    {
      planner: preset.id,
      worker: preset.id,
      verifier: preset.id,
      ...(options.review ? { reviewer: preset.id } : {}),
    },
    (id) => board.presets.get(id),
  );
  board.tasks.create({ workspaceId: "ws-task", anchorAgentId: "anchor" });
  board.tasks.savePlan("ws-task", {
    goal: "验证原生任务",
    approach: "独立证据验证",
    files: ["src/**"],
    subtasks: [],
    checks: [{ text: "接口返回正确结果", method: "请求并保存日志" }],
  });
  board.tasks.confirm("ws-task", { rolesSnapshot: roles });
  board.tasks.setPhase("ws-task", "executing");
  board.tasks.setPhase("ws-task", options.review ? "reviewing" : "verifying");
  let head = "abc123";
  const calls: string[] = [];
  const reportIds: Array<string | undefined> = [];
  const configs = new Map();
  const verify = createTaskVerifyStore(db, root);
  let collected = 0;
  let seenConfig: unknown;
  let busy = options.busy ?? false;
  const runner = createScriptedRunner((call) => {
    if (call.command === "git") {
      if (call.args[0] === "rev-parse") return { stdout: head };
      if (call.args[0] === "status") return { stdout: options.dirty ? "?? .vibe/verify.json" : "" };
      if (call.args[0] === "merge-base") return { stdout: "base123" };
    }
    return undefined;
  });
  if (options.perf) {
    mkdirSync(join(worktree, ".vibe"));
    writeFileSync(
      join(worktree, ".vibe", "verify.json"),
      JSON.stringify({
        backend: {
          perf: { label: "性能", command: "node", args: ["bench.js"], thresholdMs: 100, runs: 3 },
        },
      }),
    );
  }
  const registry = createCollectorRegistry();
  registry.register({
    id: "backend",
    projectTypes: ["backend"],
    detect: async () => ({ available: true }),
    collect: async (ctx) => {
      collected++;
      seenConfig = configs.get(ctx.verificationId);
      calls.push("collect");
      if (options.headChanges) head = "def456";
      if (options.stop) board.tasks.setPhase("ws-task", "paused");
      return {
        artifacts: options.noEvidence
          ? []
          : [writeArtifact(ctx, "log", "result.log", "接口返回 200")],
        notes: [],
        judgement: "pass",
        degraded: false,
      };
    },
  });
  const launcher: VerifierLauncher = {
    async launch(input) {
      calls.push("launch:" + input.role);
      expect(input.card).toBeUndefined();
      expect(input.task).toEqual({ workspaceId: "ws-task", anchorAgentId: "anchor" });
      expect(input.snapshot).toEqual(input.role === "reviewer" ? roles.reviewer : roles.verifier);
      const lease = await input.acquire!(input.provider, 0);
      await lease.bind("native-" + input.role);
      input.onCreated?.({
        agentId: "native-" + input.role,
        provider: input.provider,
        model: "native-resolved-model",
        candidateIndex: 0,
      });
      return {
        agentId: "native-" + input.role,
        provider: input.provider,
        async run(prompt) {
          calls.push("run:" + input.role);
          if (input.role === "reviewer")
            return {
              status: "idle",
              text: JSON.stringify({
                verdict: options.review,
                summary: "复核",
                issues:
                  options.review === "severe" ? [{ severity: "severe", text: "严重缺陷" }] : [],
              }),
            };
          if (!prompt.includes('"judgement"'))
            return { status: "idle", text: JSON.stringify({ backend: { requests: [] } }) };
          const item = {
            check: 1,
            judgement: options.judgement ?? "pass",
            note: "结论",
            evidence: ["result.log"],
          };
          return {
            status: "idle",
            text: JSON.stringify({ items: options.duplicate ? [item, item] : [item] }),
          };
        },
        async close() {
          if (options.closeFails) throw new Error("agent仍在运行");
          input.onStopped?.("native-" + input.role, "completed");
          await lease.release();
        },
      };
    },
  };
  const pipeline = createTaskPipeline({
    board,
    verify,
    registry,
    runner,
    launcher,
    configs,
    worktreeRoot: process.platform === "win32" ? "D:/devRepoCaches/worktrees" : root,
    workspace: async () => ({
      projectId: project.id,
      repoPath: worktree,
      worktreePath: worktree,
      projectTypes: ["backend"],
    }),
    acquire: async (_workspace, role) => {
      calls.push("acquire:" + role);
      if (busy) throw new Error("存在活跃写者");
      return {
        bind: async () => {
          calls.push("bind:" + role);
        },
        release: async () => {
          calls.push("release:" + role);
        },
      };
    },
    append: async (_anchor, text, verificationId) => {
      reportIds.push(verificationId);
      calls.push("summary:" + text);
    },
    tuning: () => ({ ...DEFAULT_TUNING, maxReviewReturns: options.maxReturns ?? 3 }),
    log: () => {},
  });
  return {
    db,
    board,
    verify,
    pipeline,
    calls,
    reportIds,
    runner,
    worktree,
    setBusy: (value: boolean) => {
      busy = value;
    },
    get collected() {
      return collected;
    },
    get seenConfig() {
      return seenConfig;
    },
    latest: () => verify.list("ws-task").at(-1)!,
    legacy: createVerifyStore(db, { root }),
  };
}

describe("原生 workspace 验证", () => {
  it("确认快照、只读资源、原生parent和证据全部接通，旧card为空", async () => {
    const h = setup();
    const result = await h.pipeline.run("ws-task");
    expect(result).toMatchObject({
      conclusion: "pass",
      voided: false,
      returned: false,
      commitHash: "abc123",
    });
    expect(h.board.tasks.get("ws-task")!.phase).toBe("awaiting_acceptance");
    expect(h.board.cards.list()).toHaveLength(0);
    expect(h.board.sessions.list({ workspaceId: "ws-task" })).toMatchObject([
      { cardId: null, role: "verifier", model: "native-resolved-model", state: "ended" },
    ]);
    expect(h.latest()).toMatchObject({
      cardId: null,
      workspaceId: "ws-task",
      confirmedAt: h.board.tasks.get("ws-task")!.confirmedAt,
    });
    expect(h.calls.indexOf("bind:verifier")).toBeLessThan(h.calls.indexOf("run:verifier"));
    expect(h.calls.indexOf("collect")).toBeLessThan(h.calls.indexOf("release:verifier"));
    expect(h.reportIds).toEqual([result!.verificationId]);
    expect(h.legacy.running()).toHaveLength(0);
    expect(h.legacy.get(result!.verificationId)).toBeUndefined();
    const detail = h.verify.detail(result!.verificationId)!;
    expect(detail.evidence.some((e) => e.path.endsWith("verification-report.json"))).toBe(true);
  });
  it.each(["doubt", "fail"] as const)("%s不会进入待验收", async (judgement) => {
    const h = setup({ judgement });
    expect(await h.pipeline.run("ws-task")).toMatchObject({
      conclusion: judgement,
      returned: judgement === "fail",
    });
    expect(h.board.tasks.get("ws-task")!.phase).toBe(judgement === "fail" ? "executing" : "paused");
    if (judgement === "fail") {
      const event = h.db
        .prepare<{ payload_json: string }>(
          "SELECT payload_json FROM vibe_event WHERE type = 'task.fix_requested'",
        )
        .get();
      expect(JSON.parse(event!.payload_json)).toMatchObject({
        workspaceId: "ws-task",
        commitHash: "abc123",
      });
    }
  });
  it("所有fail共用本轮自动退回上限，第二次失败暂停", async () => {
    const h = setup({ judgement: "fail", maxReturns: 1 });
    expect(await h.pipeline.run("ws-task")).toMatchObject({ returned: true });
    h.board.tasks.setPhase("ws-task", "verifying");
    expect(await h.pipeline.run("ws-task")).toMatchObject({ returned: false, conclusion: "fail" });
    expect(h.board.tasks.get("ws-task")!.phase).toBe("paused");
  });
  it("严重复核先退回，不验证即将变化的代码", async () => {
    const h = setup({ review: "severe" });
    expect(await h.pipeline.run("ws-task")).toMatchObject({ conclusion: "fail", returned: true });
    expect(h.collected).toBe(0);
    expect(h.calls).toContain("acquire:reviewer");
    expect(h.calls).not.toContain("acquire:verifier");
  });
  it("未确认任务拒绝运行", async () => {
    const h = setup();
    const task = h.board.tasks.get("ws-task")!;
    h.board.tasks.setPhase("ws-task", "paused");
    h.board.tasks.savePlan("ws-task", task.plan!);
    expect(await h.pipeline.run("ws-task")).toBeUndefined();
    expect(h.verify.list("ws-task")).toHaveLength(0);
  });
  it("活跃写者使acquire失败，不能生成pass或运行验证模型", async () => {
    const h = setup({ busy: true });
    expect(await h.pipeline.run("ws-task")).toMatchObject({ conclusion: "doubt", returned: false });
    expect(h.calls).not.toContain("run:verifier");
    expect(h.board.tasks.get("ws-task")!.phase).toBe("paused");
  });
  it("未提交的.vibe配置也阻止验证", async () => {
    const h = setup({ dirty: true });
    expect(await h.pipeline.run("ws-task")).toBeUndefined();
    expect(h.verify.list("ws-task")).toHaveLength(0);
    expect(h.board.tasks.get("ws-task")!.summary).toContain("未提交");
  });
  it.each([{ headChanges: true }, { closeFails: true }, { stop: true }])(
    "HEAD变化、停止不明或用户停止使结论作废 %j",
    async (option) => {
      const h = setup(option);
      expect(await h.pipeline.run("ws-task")).toMatchObject({
        conclusion: "doubt",
        returned: false,
      });
      expect(h.board.tasks.get("ws-task")!.phase).toBe("paused");
    },
  );
  it.each([{ noEvidence: true }, { duplicate: true }])(
    "没有证据或重复检查编号不能pass %j",
    async (option) => {
      const h = setup(option);
      expect(await h.pipeline.run("ws-task")).toMatchObject({ conclusion: "doubt" });
    },
  );
  it("并发重复触发只生成一次验证", async () => {
    const h = setup();
    await Promise.all([h.pipeline.run("ws-task"), h.pipeline.run("ws-task")]);
    expect(h.verify.list("ws-task")).toHaveLength(1);
  });
  it("无法读取git状态时拒绝伪造干净commit", async () => {
    await expect(
      taskTree(
        createScriptedRunner(() => ({ exitCode: 1, stdout: "" })),
        "/none",
      ),
    ).rejects.toThrow("无法核对");
  });
  it("性能规则保留执行阶段配置并注入真实基线", async () => {
    const h = setup({ perf: true });
    await h.pipeline.run("ws-task");
    expect(h.seenConfig).toMatchObject({
      backend: { perf: { label: "性能", thresholdMs: 100, baseline: { commitHash: "base123" } } },
    });
    expect(
      h.runner.calls.some(
        (call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "add",
      ),
    ).toBe(true);
  });
  it("Windows基线拒绝指定D盘目录之外的worktree根", () => {
    if (process.platform !== "win32") return;
    expect(() => verificationBaselineRoot("C:/temp/worktrees")).toThrow(
      "D:/devRepoCaches/worktrees",
    );
    expect(verificationBaselineRoot("D:/devRepoCaches/worktrees")).toBe(
      "D:/devRepoCaches/worktrees",
    );
  });
});
