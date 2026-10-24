import type { VerifyConfig } from "./collectors/common";
import { createHash } from "node:crypto";
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
import { EVENT_PAYLOADS, findTaskActualPreset } from "./vibe/contract";
import {
  publishEvent,
  createTaskRuntimeCommands,
  canonicalProjectPath,
  type VibeStore,
} from "./vibe/db";
import { loadVerifyConfig, VerifyConfigSchema, writeArtifact } from "./collectors/common";
import { runAutoChecks } from "./pipeline/checks";
import {
  changeDiff,
  gitStateChange,
  gitStateSnapshot,
  prepareBaseline,
  type Baseline,
  type GitStateSnapshot,
} from "./pipeline/git";
import { timelineViolations, type TimelineViolation } from "./pipeline/tamper";
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
import { readEvidenceBytes } from "./rpc";

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
  /** Reviewer/verifier timeline entries; any file edit or Git mutation voids the round. */
  timeline?(agentId: string): Promise<readonly unknown[]>;
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
  function artifactSource(
    task: Task,
    agentId: string | undefined,
    sourceKey: string,
    detail: {
      sourceKey?: string;
      epoch?: string;
      seq?: number;
      messageId?: string;
      sourceTurnId?: string;
    } = {},
  ) {
    const current = board.tasks.get(task.workspaceId);
    const tab =
      (agentId && current?.tabs.find((item) => item.agentId === agentId)) ||
      current?.tabs.find((item) => item.agentId === task.anchorAgentId) ||
      current?.tabs[0];
    if (!tab) throw new Error("验证来源找不到任务 tab，拒绝写入沉淀");
    return {
      tabNumber: tab.number,
      agentId: tab.agentId,
      ...(agentId ? { memberId: agentId, backendAgentId: agentId } : {}),
      ...(detail.epoch ? { epoch: detail.epoch } : {}),
      ...(detail.seq !== undefined ? { seq: detail.seq } : {}),
      ...(detail.messageId ? { messageId: detail.messageId } : {}),
      ...(detail.sourceTurnId ? { sourceTurnId: detail.sourceTurnId } : {}),
      sourceKey: detail.sourceKey ?? sourceKey,
    };
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
    const startedAt = now().toISOString();
    const startState = await gitStateSnapshot(runner, workspace.worktreePath);
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
    let verifierSource: VerifierAgent["source"];
    const verifiedAgents = new Set<string>();
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
    const sameConfirmation = () => {
      const current = board.tasks.get(task.workspaceId);
      return current?.confirmedAt === task.confirmedAt;
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
      confirmedAt: task.confirmedAt!,
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
      const current = board.tasks.get(task.workspaceId)!;
      snapshot = findTaskActualPreset(current, { role, admittedOnly: true }) ?? snapshot;
      const entries = Array.isArray(current.control?.actualModels)
        ? current.control.actualModels
        : [];
      const actual = entries.findLast(
        (entry) =>
          entry?.role === role &&
          entry?.confirmedAt === task.confirmedAt &&
          entry?.admitted !== false &&
          entry?.presetId === snapshot.presetId &&
          entry?.presetSnapshot,
      );
      const candidateIndex = typeof actual?.candidateIndex === "number" ? actual.candidateIndex : 0;
      const first = snapshot.models[candidateIndex];
      if (!first) throw new Error("实际接手模型候选无效，请核对任务后重新验证");
      let previousSessionId: string | undefined;
      let forceNewMember = false;
      const leaf = runtime
        .listSessions({ workspaceId: task.workspaceId })
        .findLast(
          (session) =>
            session.role === role &&
            session.currentProvider === first.provider &&
            session.candidateIndex === candidateIndex &&
            (session.confirmedAt === task.confirmedAt || session.model === first.model) &&
            !runtime.getContinuation(session.id),
        );
      if (leaf?.state === "ended") {
        const ended = board.db
          .prepare<{ payload_json: string }>(
            "SELECT payload_json FROM vibe_event WHERE type = 'session.ended' AND json_extract(payload_json, '$.sessionId') = ? ORDER BY seq DESC LIMIT 1",
          )
          .get(leaf.id);
        const event = EVENT_PAYLOADS["session.ended"].safeParse(
          ended ? JSON.parse(ended.payload_json) : undefined,
        );
        const outcome =
          event.success && event.data.agentId === leaf.agentId ? event.data.outcome : undefined;
        if (["failed", "canceled"].includes(outcome ?? "")) {
          if (leaf.confirmedAt === task.confirmedAt) previousSessionId = leaf.id;
          else forceNewMember = true;
        } else if (outcome !== "completed") forceNewMember = true;
      }
      const agent = await deps.launcher.launch({
        task: {
          workspaceId: task.workspaceId,
          confirmedAt: task.confirmedAt!,
          commitHash: initial.head,
        },
        project: { id: workspace.projectId },
        workspaceId: task.workspaceId,
        sourceAgentId: task.anchorAgentId,
        cwd: workspace.worktreePath,
        outputDir: ctx.outputDir,
        provider: first.provider,
        model: first.model,
        thinking: first.thinking,
        snapshot,
        candidateIndex,
        forceNewMember,
        role,
        previousSessionId: () => previousSessionId,
        onCreated: (selection) => {
          verifiedAgents.add(selection.agentId);
          verify.setVerifier(vid, selection.agentId);
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
            if (outcome === "failed") board.sessions.setState(session.id, "ended", { outcome });
            else board.sessions.setState(session.id, "idle");
        },
        acquire: async (provider, selectedIndex) => {
          const lease = await deps.acquire(task.workspaceId, role, provider, selectedIndex);
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
      const setupReply = await ask(agent, "verify.task.setup", {
        baseline: baseline ? JSON.stringify(baseline) : "没有可用基线",
      });
      if (
        setupReply &&
        typeof setupReply === "object" &&
        !Array.isArray(setupReply) &&
        "$schema" in setupReply
      )
        delete (setupReply as Record<string, unknown>).$schema;
      const parsed = VerifyConfigSchema.strict().safeParse(setupReply);
      if (!parsed.success)
        throw new Error(
          "验证模型没有提供有效的证据采集配置；本轮仅接受配置 schema，不能把复核结论当作采集配置",
        );
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
          deps.registry
            .forProjectType(type)
            .map((collector) => [collector.id, { collector, type }] as const),
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
    async function collectGitEvidence() {
      const commands: Array<{
        args: string[];
        result: Awaited<ReturnType<Runner["run"]>>;
      }> = [];
      let error: string | null = null;
      const read = async (args: string[]) => {
        const result = await runner.run("git", args, {
          cwd: workspace.worktreePath,
          timeoutMs: 60_000,
        });
        commands.push({ args, result });
        if (result.exitCode !== 0 || result.timedOut)
          throw new Error(
            `git ${args.join(" ")} 采集失败：${result.stderr || result.stdout || "未成功结束"}`,
          );
        return result.stdout;
      };
      try {
        await ensureStable();
        const head = (await read(["rev-parse", "HEAD"])).trim();
        const status = await read(["status", "--porcelain=v1", "--untracked-files=all"]);
        if (head !== initial.head || status.trim()) throw new Error("Git 证据不匹配本轮干净提交");
        const latest = await read(["log", "-1", "--format=%H%n%s", "--name-status", initial.head]);
        if (!latest.startsWith(initial.head + "\n"))
          throw new Error("Git 最新提交原文缺失或不匹配");
        await read(["ls-files"]);
        const base = (await read(["merge-base", initial.head, "main"])).trim();
        if (!base) throw new Error("无法取得任务相对 main 的共同基线");
        await read(["diff", "--stat", base, initial.head, "--"]);
        await read(["diff", base, initial.head, "--"]);
        await ensureStable();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const artifact = writeArtifact(
        ctx,
        "report",
        "git-evidence.json",
        JSON.stringify(
          {
            workspaceId: task.workspaceId,
            confirmedAt: task.confirmedAt,
            commitHash: initial.head,
            status: error ? "incomplete" : "collected",
            error,
            commands,
          },
          null,
          2,
        ),
        "本轮提交、干净工作树、文件清单与 main 差异的 Git 原文",
      );
      add(
        "Git 原始证据",
        "collector",
        error ? "doubt" : "pass",
        error ?? "已核对本轮提交与干净状态，保存原始 Git 输出",
        [artifact],
      );
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
      const reviewerPreset =
        findTaskActualPreset(board.tasks.get(task.workspaceId)!, {
          role: "reviewer",
          admittedOnly: true,
        }) ?? task.rolesSnapshot!.reviewer;
      if (reviewerPreset) {
        await ensureStable();
        if (board.tasks.get(task.workspaceId)!.phase === "verifying")
          board.db.immediate(() => {
            // Revalidation includes configured review; keep the existing phase transition contract.
            board.tasks.setPhase(task.workspaceId, "paused");
            board.tasks.setPhase(task.workspaceId, "reviewing");
          });
        await withAgent("reviewer", reviewerPreset, async (agent) => {
          const diff = await changeDiff(runner, workspace.worktreePath, ["main", "master"]);
          const latestSources = new Map<
            string,
            ReturnType<typeof board.taskArtifacts.list>[number]
          >();
          for (const artifact of board.taskArtifacts.list(task.workspaceId, {
            confirmedAt: task.confirmedAt!,
          })) {
            if (artifact.kind !== "delivery") continue;
            if (
              typeof artifact.data?.commitHash === "string" &&
              artifact.data.commitHash !== initial.head
            )
              continue;
            latestSources.set(
              artifact.kind +
                ":" +
                (artifact.source.memberId ?? artifact.source.backendAgentId ?? "task"),
              artifact,
            );
          }
          const previousReports = verify
            .list(task.workspaceId, task.confirmedAt!)
            .filter(
              (candidate) =>
                candidate.id !== vid &&
                candidate.finishedAt &&
                candidate.commitHash === initial.head,
            );
          const latestRaw = previousReports.findLast((candidate) => {
            const collectorItems = new Set(
              verify
                .items(candidate.id)
                .filter((item) => item.method === "collector" || item.method.startsWith("auto:"))
                .map((item) => item.id),
            );
            return verify
              .evidence(candidate.id)
              .some(
                (file) =>
                  file.commitHash === initial.head &&
                  file.itemId !== null &&
                  collectorItems.has(file.itemId) &&
                  ["log", "report"].includes(file.kind),
              );
          });
          // Reuse independently collected bytes, never an earlier attempt's verdict or
          // interrupted pipeline report. Public history still preserves those conclusions.
          const priorEvidence = (latestRaw ? [latestRaw] : []).map((previous) => {
            const collectorItems = verify
              .items(previous.id)
              .filter((item) => item.method === "collector" || item.method.startsWith("auto:"));
            const itemIds = new Set(collectorItems.map((item) => item.id));
            return {
              verificationId: previous.id,
              confirmedAt: previous.confirmedAt,
              commitHash: previous.commitHash,
              startedAt: previous.startedAt,
              finishedAt: previous.finishedAt,
              items: collectorItems,
              evidence: verify
                .evidence(previous.id)
                .filter(
                  (file) =>
                    file.verificationId === previous.id &&
                    file.commitHash === initial.head &&
                    file.itemId !== null &&
                    itemIds.has(file.itemId),
                )
                .map((file) => {
                  const source = {
                    id: file.id,
                    verificationId: previous.id,
                    path: file.path,
                    kind: file.kind,
                    capturedAt: file.capturedAt,
                    commitHash: file.commitHash,
                    sha256: file.sha256,
                    simulated: file.simulated,
                  };
                  try {
                    const bytes = readEvidenceBytes(file.path, verify.dirFor(previous.id));
                    if (
                      !file.sha256 ||
                      createHash("sha256").update(bytes).digest("hex") !== file.sha256
                    )
                      throw new Error("证据文件校验值不匹配");
                    return Object.assign(source, {
                      excerpt: textExcerpt(file.path, file.kind, tuning().excerptChars),
                    });
                  } catch (error) {
                    return Object.assign(source, {
                      unavailableReason: error instanceof Error ? error.message : String(error),
                    });
                  }
                }),
            };
          });
          const review = ReviewSchema.parse(
            await ask(agent, "verify.task.review", {
              diff: diff.diff,
              stat: diff.stat,
              subtaskRuns: JSON.stringify(board.tasks.get(task.workspaceId)!.subtaskRuns, null, 2),
              priorEvidence: JSON.stringify(priorEvidence, null, 2),
              reviewSources: JSON.stringify(
                [...latestSources.values()].map((artifact) => ({
                  kind: artifact.kind,
                  sourceKey: artifact.sourceKey,
                  source: artifact.source,
                  summary: artifact.summary,
                  createdAt: artifact.createdAt,
                  commitHash: artifact.data?.commitHash,
                  materialUse:
                    artifact.data?.commitHash === initial.head
                      ? "当前提交的交付声称，须对照代码与独立证据核实"
                      : "未绑定提交的交付声称，不能作为当前提交的证据",
                  evidence: artifact.data?.evidence,
                  report: artifact.data?.report,
                })),
                null,
                2,
              ),
            }),
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
          const sourceKey = "verification:" + vid + ":review";
          board.taskArtifacts.record({
            workspaceId: task.workspaceId,
            kind: "review",
            sourceKey,
            confirmedAt: task.confirmedAt,
            source: artifactSource(task, agent.agentId, sourceKey, agent.source),
            summary: notes.at(-1)!,
            data: { verificationId: vid, commitHash: initial.head, review: { ...review, issues } },
          });
        });
      }
      // Severe review findings are returned before collecting evidence for code that must change.
      if (!verify.items(vid).some((i) => i.kind === "review" && i.judgement === "fail")) {
        board.tasks.setPhase(task.workspaceId, "verifying");
        await withAgent("verifier", task.rolesSnapshot!.verifier, async (agent) => {
          const config = await configureEvidence(agent);
          deps.configs.set(vid, config);
          await collectEvidence(config);
          await collectGitEvidence();
          await judgeEvidence(agent);
          verifierSource = agent.source;
        });
      }
    } catch (error) {
      notes.push("验证中断：" + (error instanceof Error ? error.message : String(error)));
      add("验证运行完整性", "runtime", "doubt", notes.at(-1)!);
    } finally {
      deps.configs.delete(vid);
      if (baseline) notes.push("保留验证基线 worktree：" + baseline.path);
    }
    try {
      await ensureStable();
    } catch (error) {
      voided = true;
      notes.push(String(error));
    }
    let endState: GitStateSnapshot | undefined;
    try {
      endState = await gitStateSnapshot(runner, workspace.worktreePath);
      const changed = gitStateChange(startState, endState);
      if (changed) {
        voided = true;
        notes.push("验证开始与结束的 Git 状态不一致：" + changed);
      }
    } catch (error) {
      voided = true;
      notes.push(
        "验证结束 Git 状态快照失败：" + (error instanceof Error ? error.message : String(error)),
      );
    }
    let violations: TimelineViolation[] = [];
    try {
      const pages = await Promise.all(
        [...verifiedAgents].map((agentId) => (deps.timeline ? deps.timeline(agentId) : [])),
      );
      violations = await timelineViolations(pages.flat(), {
        root: workspace.worktreePath,
        since: startedAt,
        ignored: async (paths) => {
          const result = await runner.run("git", ["check-ignore", "--stdin"], {
            cwd: workspace.worktreePath,
            timeoutMs: 60_000,
            input: paths.join("\n"),
          });
          if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) {
            notes.push("无法判断被忽略的文件，编辑记录按未忽略处理");
            return new Set<string>();
          }
          return new Set(
            result.stdout
              .split(/\r?\n/)
              .map((path) => path.trim())
              .filter(Boolean),
          );
        },
      });
    } catch (error) {
      voided = true;
      notes.push(
        "无法核对验证 tab 时间线，结论作废：" +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (violations.length) {
      voided = true;
      const text = violations.map((violation) => violation.summary).join("；");
      notes.push("验证 tab 修改了工作区或 Git 状态，结论作废：" + text);
      add("验证 tab 完整性", "runtime", "doubt", text);
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
          gitState: { start: startState, end: endState ?? null },
          timelineViolations: violations,
        },
        null,
        2,
      ),
    );
    verify.addEvidence(vid, null, report);
    verify.writeNotes(vid, notes);
    verify.finish(vid, conclusion);
    if (sameConfirmation()) {
      const sourceKey = "verification:" + vid;
      board.taskArtifacts.record({
        workspaceId: task.workspaceId,
        kind: "verification",
        sourceKey,
        confirmedAt: task.confirmedAt,
        source: artifactSource(task, verifierSource?.backendAgentId, sourceKey, verifierSource),
        summary: verificationLine(conclusion, items, initial.head, false),
        data: {
          verificationId: vid,
          commitHash: initial.head,
          conclusion,
          voided,
          report: report.path,
          evidence: verify
            .evidence(vid)
            .map((file) => ({ id: file.id, kind: file.kind, path: file.path })),
        },
      });
    }
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
