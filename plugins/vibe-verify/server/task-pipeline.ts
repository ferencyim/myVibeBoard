import type { VerifyConfig } from "./collectors/common";
import { basename, join } from "node:path";
import type {
  CollectorRegistry,
  EvidenceArtifact,
  Judgement,
  ProjectType,
  Runner,
  Task,
  TaskCollectorContext,
  TaskPresetSnapshot,
} from "./vibe/contract";
import {
  publishEvent,
  createTaskRuntimeCommands,
  canonicalProjectPath,
  type VibeStore,
} from "./vibe/db";
import { loadVerifyConfig, VerifyConfigSchema, writeArtifact } from "./collectors/common";
import { taskCollectors } from "./collectors/context";
import { runAutoChecks } from "./pipeline/checks";
import { changeDiff, prepareBaseline, removeWorktree, type Baseline } from "./pipeline/git";
import { textExcerpt, verificationLine } from "./pipeline";
import { aggregate } from "./store";
import type { TaskVerifyStore } from "./task-store";
import { defaultPrompts, type PromptResolver } from "./prompts";
import type { RunConfigs } from "./registry";
import { ReviewSchema, reviewVerdict, issueLocation } from "./review";
import {
  VerdictSchema,
  parseJsonLoose,
  type VerifierLauncher,
  type VerifierAgent,
} from "./verifier/agent";
import { defaultTuning, type TuningSource } from "./tuning";

export interface TaskWorkspace {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  projectTypes: ProjectType[];
}
export interface TaskResourceLease {
  bind(agentId: string): Promise<void>;
  release(): Promise<void>;
}
export interface TaskPipelineDeps {
  board: VibeStore;
  verify: TaskVerifyStore;
  registry: CollectorRegistry;
  runner: Runner;
  launcher: VerifierLauncher;
  configs: RunConfigs;
  worktreeRoot: string;
  workspace(workspaceId: string): Promise<TaskWorkspace>;
  acquire(
    workspaceId: string,
    role: "reviewer" | "verifier",
    provider: string,
    candidateIndex: number,
  ): Promise<TaskResourceLease>;
  append(anchorAgentId: string, text: string, verificationId?: string): Promise<void>;
  prompts?: PromptResolver;
  tuning?: TuningSource;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export function verificationBaselineRoot(baselineRoot: string): string {
  if (process.platform === "win32") {
    const canonical = canonicalProjectPath(baselineRoot);
    if (
      canonical !== "d:/devrepocaches/worktrees" &&
      !canonical.startsWith("d:/devrepocaches/worktrees/")
    )
      throw new Error("Windows 验证基线 worktree 必须位于 D:/devRepoCaches/worktrees");
  }

  return baselineRoot;
}

/** No .vibe exclusion: all code and config must belong to the verified commit. */
export async function taskTree(runner: Runner, cwd: string) {
  const head = await runner.run("git", ["rev-parse", "HEAD"], { cwd });
  const status = await runner.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
  });
  if (
    head.exitCode !== 0 ||
    status.exitCode !== 0 ||
    head.timedOut ||
    status.timedOut ||
    !head.stdout.trim()
  )
    throw new Error("无法核对任务 Git 提交与工作树");
  return { head: head.stdout.trim(), status: status.stdout.trim() };
}

const acceptancePhase = (conclusion: Judgement) =>
  conclusion === "pass" ? ("awaiting_acceptance" as const) : ("paused" as const);

export function createTaskPipeline(deps: TaskPipelineDeps) {
  const { board, verify, runner } = deps;
  const runtime = createTaskRuntimeCommands(board.db);
  const active = new Set<string>();
  const tuning = deps.tuning ?? defaultTuning;
  const prompts = deps.prompts ?? defaultPrompts;
  const now = deps.now ?? (() => new Date());
  const log =
    deps.log ?? ((message, error) => console.error("[vibe-verify]", message, error ?? ""));
  async function announce(task: Task, text: string, verificationId?: string) {
    board.tasks.setSummary(task.workspaceId, text);
    await deps
      .append(task.anchorAgentId, text, verificationId)
      .catch((error) => log("原生验证摘要追加失败", error));
  }
  async function run(workspaceId: string) {
    const task = board.tasks.get(workspaceId);
    if (
      !task ||
      !task.confirmedAt ||
      !task.plan ||
      !task.rolesSnapshot ||
      !["reviewing", "verifying"].includes(task.phase) ||
      active.has(workspaceId)
    )
      return;
    active.add(workspaceId);
    try {
      return await execute(task);
    } catch (error) {
      if (
        board.tasks.get(workspaceId)?.confirmedAt === task.confirmedAt &&
        ["reviewing", "verifying"].includes(board.tasks.get(workspaceId)!.phase)
      ) {
        board.tasks.setPhase(workspaceId, "paused");
        await announce(
          task,
          "验证未能启动：" +
            (error instanceof Error ? error.message : String(error)) +
            "。请处理后重新验证。",
        );
      }
      log("任务验证失败", error);
    } finally {
      active.delete(workspaceId);
    }
  }
  async function execute(task: Task) {
    const workspace = await deps.workspace(task.workspaceId);
    const initial = await taskTree(runner, workspace.worktreePath);
    if (initial.status) throw new Error("工作树有未提交改动，须先收口提交再验证");
    const created = verify.create({
      workspaceId: task.workspaceId,
      confirmedAt: task.confirmedAt!,
      projectId: workspace.projectId,
      commitHash: initial.head,
      checks: task.plan!.checks,
    });
    const vid = created.verification.id;
    const notes: string[] = [];
    let voided = false;
    let stopped = true;
    let baseline: Baseline | undefined;
    const ctx: TaskCollectorContext = {
      cardId: null,
      workspaceId: task.workspaceId,
      confirmedAt: task.confirmedAt!,
      verificationId: vid,
      projectType: workspace.projectTypes[0] ?? "backend",
      projectPath: workspace.repoPath,
      worktreePath: workspace.worktreePath,
      commitHash: initial.head,
      outputDir: verify.dirFor(vid),
      runner,
      now,
      log: (message) => log(message),
    };
    const sameRound = () => {
      const current = board.tasks.get(task.workspaceId);
      return (
        current?.confirmedAt === task.confirmedAt &&
        ["reviewing", "verifying"].includes(current.phase)
      );
    };
    const ensureStable = async () => {
      if (!sameRound()) throw new Error("任务已停止或本轮确认已变化");
      const tree = await taskTree(runner, workspace.worktreePath);
      if (tree.head !== initial.head || tree.status) {
        voided = true;
        throw new Error("提交或工作树已变化，本轮验证结论失效");
      }
    };
    const add = (
      text: string,
      method: string,
      judgement: Judgement,
      note: string,
      artifacts: EvidenceArtifact[] = [],
      kind: "check" | "review" = "check",
    ) => {
      const item = verify.addItem(vid, { text, method, kind });
      const files = artifacts.map((a) => verify.addEvidence(vid, item.id, a));
      verify.judgeItem(
        item.id,
        judgement,
        note,
        files.map((f) => f.id),
      );
      return item;
    };
    const vars = {
      workspaceId: task.workspaceId,
      worktree: workspace.worktreePath,
      commitHash: initial.head,
      outputDir: ctx.outputDir,
      plan: JSON.stringify(task.plan, null, 2),
      checks: task
        .plan!.checks.map((c, n) => String(n + 1) + ". " + c.text + "（" + c.method + "）")
        .join("\n"),
    };
    async function withAgent(
      role: "reviewer" | "verifier",
      snapshot: TaskPresetSnapshot,
      body: (agent: Awaited<ReturnType<VerifierLauncher["launch"]>>) => Promise<void>,
    ) {
      const first = snapshot.models[0]!;
      let previousSessionId: string | undefined;
      const agent = await deps.launcher.launch({
        task: { workspaceId: task.workspaceId, anchorAgentId: task.anchorAgentId },
        project: { id: workspace.projectId },
        workspaceId: task.workspaceId,
        cwd: workspace.worktreePath,
        outputDir: ctx.outputDir,
        provider: first.provider,
        model: first.model,
        thinking: first.thinking,
        snapshot,
        role,
        onCreated: (selection) => {
          const session = previousSessionId
            ? runtime.recordContinuation({
                fromSessionId: previousSessionId,
                ...selection,
                reason: "验证模型不可用，按确认快照顺序接续",
              }).to
            : runtime.registerSession({
                ...selection,
                workspaceId: task.workspaceId,
                projectId: workspace.projectId,
                role,
                confirmedAt: task.confirmedAt,
              });
          previousSessionId = session.id;
        },
        onStopped: (agentId, outcome) => {
          const session = runtime.findSessionByAgent(agentId);
          if (session && session.state !== "ended")
            board.sessions.setState(session.id, "ended", { outcome });
        },
        acquire: async (provider, candidateIndex) => {
          const lease = await deps.acquire(task.workspaceId, role, provider, candidateIndex);
          return {
            bind: async (id) => {
              await lease.bind(id);
              verify.setVerifier(vid, id);
            },
            release: lease.release,
          };
        },
      });
      let bodyError: unknown;
      try {
        await ensureStable();
        await body(agent);
        await ensureStable();
      } catch (error) {
        bodyError = error;
      }
      try {
        await agent.close();
      } catch (error) {
        stopped = false;
        throw error;
      }
      if (bodyError) throw bodyError;
    }
    const ask = async (
      agent: Awaited<ReturnType<VerifierLauncher["launch"]>>,
      key: string,
      extra: Record<string, string> = {},
    ) => {
      await ensureStable();
      const result = await agent.run(
        prompts.resolve(key, { projectId: workspace.projectId, vars: { ...vars, ...extra } }),
      );
      await ensureStable();
      if (result.status !== "idle")
        throw new Error(
          "模型未正常完成：" + result.status + (result.error ? "：" + result.error : ""),
        );
      return parseJsonLoose(result.text);
    };

    async function configureEvidence(agent: VerifierAgent): Promise<VerifyConfig> {
      const existing = loadVerifyConfig(workspace.worktreePath);
      if (workspace.projectTypes.includes("web") || existing.backend?.perf) {
        const baselineRoot = verificationBaselineRoot(tuning().worktreeRoot || deps.worktreeRoot);
        baseline = await prepareBaseline(
          runner,
          workspace.worktreePath,
          join(baselineRoot, "verify-task-" + vid),
          ["main", "master"],
        );
        if (!baseline) notes.push("没有可用基线提交，前后对比只能存疑");
      }
      const parsed = VerifyConfigSchema.safeParse(
        await ask(agent, "verify.task.setup", {
          baseline: baseline ? JSON.stringify(baseline) : "没有可用基线",
        }),
      );
      if (!parsed.success) throw new Error("验证模型没有提供有效的证据采集配置");
      let config = parsed.data;
      if (existing.backend?.perf && !config.backend?.perf)
        config = {
          ...config,
          backend: {
            ...config.backend,
            requests: config.backend?.requests ?? [],
            perf: existing.backend.perf,
          },
        };
      if (!baseline) return config;
      if (config.web && !config.web.baseline)
        config = {
          ...config,
          web: {
            ...config.web,
            baseline: { path: baseline.path, commitHash: baseline.commitHash },
          },
        };
      if (config.backend?.perf && !config.backend.perf.baseline)
        config = {
          ...config,
          backend: {
            ...config.backend,
            perf: {
              ...config.backend.perf,
              baseline: { path: baseline.path, commitHash: baseline.commitHash },
            },
          },
        };
      return config;
    }
    async function collectEvidence(config: VerifyConfig) {
      let backendRan = false;
      const collectors = new Map(
        workspace.projectTypes.flatMap((type) =>
          taskCollectors(deps.registry, type).map(
            (collector) => [collector.id, { collector, type }] as const,
          ),
        ),
      );
      for (const { collector, type } of collectors.values()) {
        const local = { ...ctx, projectType: type };
        try {
          await ensureStable();
          const available = await collector.detect(local);
          if (!available.available) {
            add(
              "证据采集：" + collector.id,
              "collector",
              "doubt",
              available.reason ?? "采集器不可用",
            );
            continue;
          }
          const collect = async (check?: { id: string; text: string; method: string }) => {
            const result = await collector.collect({ ...local, check });
            add(
              "证据采集：" + collector.id + (check ? "（检查 " + check.id + "）" : ""),
              "collector",
              result.judgement ?? "doubt",
              [...result.notes, ...(result.degraded ? ["已使用降级方式采集"] : [])].join("；"),
              result.artifacts,
            );
          };
          await collect();
          if (collector.id === "backend") backendRan = true;
          const ids = [
            ...new Set(
              (config.backend?.requests ?? []).flatMap((request) =>
                request.checkId ? [request.checkId] : [],
              ),
            ),
          ];
          for (const id of ids) {
            const check = task.plan!.checks[Number(id) - 1];
            if (check) await collect({ id, ...check });
          }
          await ensureStable();
        } catch (error) {
          add("证据采集：" + collector.id, "collector", "doubt", String(error));
        } finally {
          await collector.dispose?.(local);
        }
      }
      for (const check of await runAutoChecks(ctx, runner, { skipTests: backendRan }))
        add(check.text, check.method, check.judgement, check.note, check.artifacts);
    }
    async function judgeEvidence(agent: VerifierAgent) {
      const files = verify.evidence(vid);
      if (files.length === 0) add("证据完整性", "evidence", "doubt", "本轮没有可供核对的证据文件");
      const verdict = VerdictSchema.parse(
        await ask(agent, "verify.task.judge", {
          evidence: files
            .map(
              (file) =>
                basename(file.path) +
                "（" +
                file.kind +
                "）\n" +
                (textExcerpt(file.path, file.kind, tuning().excerptChars) ?? ""),
            )
            .join("\n"),
          notes: verify
            .items(vid)
            .map((item) => item.checkText + "：" + (item.note ?? ""))
            .join("\n"),
        }),
      );
      const counts = new Map<number, number>();
      for (const item of verdict.items) counts.set(item.check, (counts.get(item.check) ?? 0) + 1);
      for (const item of verdict.items) {
        const check = created.items[item.check - 1];
        if (!check || counts.get(item.check) !== 1) continue;
        const evidence = files.filter((file) => item.evidence.includes(basename(file.path)));
        verify.judgeItem(
          check.id,
          item.judgement === "pass" && evidence.length === 0 ? "doubt" : item.judgement,
          item.note +
            (item.judgement === "pass" && evidence.length === 0 ? "；缺少对应证据，改为存疑" : ""),
          evidence.map((file) => file.id),
        );
      }
      if (verdict.summary) notes.push(verdict.summary);
    }
    try {
      if (task.rolesSnapshot!.reviewer) {
        if (task.phase !== "verifying") board.tasks.setPhase(task.workspaceId, "reviewing");
        await withAgent("reviewer", task.rolesSnapshot!.reviewer, async (agent) => {
          const diff = await changeDiff(runner, workspace.worktreePath, ["main", "master"]);
          const review = ReviewSchema.parse(
            await ask(agent, "verify.task.review", { diff: diff.diff, stat: diff.stat }),
          );
          let issues = review.issues;
          if (!issues.length && review.verdict && review.verdict !== "pass")
            issues = [
              {
                severity: review.verdict === "severe" ? "severe" : "major",
                text: review.summary || "复核报告问题但未提供细节",
              },
            ];
          if (!issues.length) add("代码复核", "review", "pass", review.summary, [], "review");
          for (const issue of issues)
            add(
              issue.text,
              "review:" + issue.severity,
              issue.severity === "severe" ? "fail" : "doubt",
              issueLocation(issue),
              [],
              "review",
            );
          notes.push("复核结论：" + reviewVerdict({ ...review, issues }) + " " + review.summary);
        });
      }
      // Severe review findings are returned before collecting evidence for code that must change.
      if (!verify.items(vid).some((i) => i.kind === "review" && i.judgement === "fail")) {
        board.tasks.setPhase(task.workspaceId, "verifying");
        await withAgent("verifier", task.rolesSnapshot!.verifier, async (agent) => {
          const config = await configureEvidence(agent);
          deps.configs.set(vid, config);
          await collectEvidence(config);
          await judgeEvidence(agent);
        });
      }
    } catch (error) {
      notes.push("验证中断：" + (error instanceof Error ? error.message : String(error)));
      add("验证运行完整性", "runtime", "doubt", notes.at(-1)!);
    } finally {
      deps.configs.delete(vid);
      if (baseline) {
        const problem = await removeWorktree(runner, workspace.worktreePath, baseline.path);
        if (problem) notes.push("保留基线worktree：" + problem);
      }
    }
    try {
      await ensureStable();
    } catch (error) {
      voided = true;
      notes.push(String(error));
    }
    if (voided || !stopped)
      for (const item of verify.items(vid))
        verify.judgeItem(item.id, "doubt", "结论已失效：" + (item.note ?? ""), item.evidenceIds);
    for (const item of verify.items(vid))
      if (item.judgement === null) verify.judgeItem(item.id, "doubt", "未取得有效判定");
    const items = verify.items(vid);
    const conclusion = aggregate(items.map((item) => item.judgement));
    const report = writeArtifact(
      ctx,
      "report",
      "verification-report.json",
      JSON.stringify(
        {
          workspaceId: task.workspaceId,
          confirmedAt: task.confirmedAt,
          commitHash: initial.head,
          conclusion,
          voided,
          items,
          notes,
        },
        null,
        2,
      ),
    );
    verify.addEvidence(vid, null, report);
    verify.writeNotes(vid, notes);
    verify.finish(vid, conclusion);
    return conclude();
    async function conclude() {
      let returned = false;
      if (sameRound()) {
        const failCount = verify
          .list(task.workspaceId, task.confirmedAt!)
          .filter((v) => v.conclusion === "fail").length;
        returned =
          conclusion === "fail" &&
          !voided &&
          stopped &&
          tuning().autoReturnOnFail &&
          failCount <= tuning().maxReviewReturns;
        board.tasks.setPhase(
          task.workspaceId,
          returned ? "executing" : acceptancePhase(conclusion),
        );
        let suffix = "。任务已暂停，请用户处理后重新验证。";
        if (conclusion === "pass") suffix = "。等待用户在原生对话单独发送「通过」。";
        if (returned) suffix = "。已退回执行阶段等待资源重新准入，修复后必须重新验证。";
        await announce(
          task,
          verificationLine(conclusion, items, initial.head, false) +
            (voided ? "，本轮任务或代码状态变化，证据作废" : "") +
            " · 证据 " +
            vid +
            suffix,
          vid,
        );
        if (returned)
          publishEvent(
            board.db,
            {
              type: "task.fix_requested",
              projectId: workspace.projectId,
              payload: {
                workspaceId: task.workspaceId,
                confirmedAt: task.confirmedAt!,
                verificationId: vid,
                commitHash: initial.head,
                prompt: prompts.resolve("verify.task.fix", {
                  projectId: workspace.projectId,
                  vars: {
                    ...vars,
                    failed: items
                      .filter((i) => i.judgement === "fail")
                      .map((i) => i.checkText + "：" + (i.note ?? ""))
                      .join("\n"),
                  },
                }),
              },
            },
            now,
          );
      }
      return { verificationId: vid, conclusion, voided, returned, commitHash: initial.head };
    }
  }
  return { run, isRunning: (workspaceId: string) => active.has(workspaceId) };
}
export type TaskPipeline = ReturnType<typeof createTaskPipeline>;
