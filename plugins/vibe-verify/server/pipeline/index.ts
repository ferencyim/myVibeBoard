// Verification pipeline (WP-20). Triggered when a card reaches `verifying`:
//
//   evidence mode  : verifier agent round 1 (writes verify.json) -> collectors from the registry
//                    -> automatic tests/lint -> verifier round 2 (judges the evidence per check)
//   tests_only mode: automatic tests + lint -> verifier round 2 (judges the checks on their logs)
//
// WP-108: every card is verified by a verification model - the card's pick, else the project /
// global default (resolveModel "verifier"); only when none is set anywhere (a card the scheduler
// dispatched) the old automatic pick runs, and the notes say so.
//
// then aggregate (fail > doubt > pass), store, and on failure send the card back to `in_progress`
// (actor verifier) with the failing evidence as the worker's next prompt.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveModel,
  type CardView,
  type PlanVersion,
  type Project,
  type CollectorContext,
  type CollectorRegistry,
  type EvidenceArtifact,
  type Judgement,
  type Runner,
  type VerificationItem,
} from "../vibe/contract";
import { publishEvent, type VibeStore } from "../vibe/db";
import { VerifyConfigSchema, loadVerifyConfig, type PerfConfig, type VerifyConfig } from "../collectors/common";
import { type VerifierLauncher, type PickVerifier, VerdictSchema, parseJsonLoose, pickProvider } from "../verifier/agent";
import { defaultPrompts, type PromptResolver } from "../prompts";
import { defaultTuning, type TuningSource } from "../tuning";
import { aggregate, type VerifyStore } from "../store";
import { runAutoChecks, splitChecks } from "./checks";
import { changeDiff, prepareBaseline, type Baseline, removeWorktree, sameSnapshot, snapshotTree, headCommit } from "./git";
import { buildFailurePrompt, buildJudgePrompt, buildSetupPrompt, type FailedItem } from "./prompts";
import type { RunConfigs } from "../registry";
import {
  ReviewSchema,
  buildReviewPrompt,
  issueJudgement,
  issueLocation,
  reviewChatText,
  reviewVerdict,
  type ReviewIssue,
} from "../review";

export interface PipelineDeps {
  board: VibeStore;
  verify: VerifyStore;
  registry: CollectorRegistry;
  runner: Runner;
  launcher: VerifierLauncher;
  configs: RunConfigs;
  /** Sends a prompt to the worker agent; false = could not be delivered. */
  notifyWorker: (agentId: string, prompt: string) => Promise<boolean>;
  pickVerifier?: PickVerifier;
  /** Owner settings (return policy, severity map, timeouts); read on every use. */
  tuning?: TuningSource;
  /** Prompt texts (registry); defaults to the registered defaults. */
  prompts?: PromptResolver;
  /** Where baseline worktrees are created (Windows: must be on D:); the worktreeRoot setting wins. */
  worktreeRoot: string;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
  signal?: AbortSignal;
}

export interface PipelineResult {
  verificationId: string;
  conclusion: Judgement;
  voided: boolean;
  returned: boolean;
}

/** Head and tail of a small text evidence file (logs, reports); undefined for binary kinds. */
export function textExcerpt(file: string, kind: string, excerptChars: number): string | undefined {
  if (kind !== "log" && kind !== "report") return undefined;
  try {
    const text = readFileSync(file, "utf8");
    return text.length <= excerptChars
      ? text
      : `${text.slice(0, excerptChars / 2)}
...[cut]...
${text.slice(-excerptChars / 2)}`;
  } catch {
    return undefined;
  }
}

/** The `backend.perf` block of the worktree's own `.vibe/verify.json` (written by the worker of a perf fix). */
function readExistingPerf(worktree: string): PerfConfig | undefined {
  try {
    return loadVerifyConfig(worktree).backend?.perf;
  } catch {
    return undefined;
  }
}

const CONCLUSION_ZH: Record<Judgement, string> = { pass: "验证通过", doubt: "验证存疑", fail: "验证未通过" };
const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One system line for the card's group chat: result, counts per judgement, commit (the UI links it to the verification tab). */
export function verificationLine(
  conclusion: Judgement,
  items: readonly Pick<VerificationItem, "judgement">[],
  commitHash: string,
  voided: boolean,
): string {
  const count = (j: Judgement) => items.filter((i) => i.judgement === j).length;
  const parts = `通过 ${count("pass")} / 存疑 ${count("doubt")} / 失败 ${count("fail")}`;
  return `${CONCLUSION_ZH[conclusion]}（${parts}）· 提交 ${commitHash.slice(0, 8)}${voided ? "，验证 agent 改动了代码，证据作废" : ""}`;
}

/** Why an automatic return happened, with the failing checks (shown as a system line in the group chat). */
export function returnReason(review: boolean, failed: readonly { text: string }[]): string {
  const head = review ? "复核发现严重问题，已自动退回执行 agent" : "验证未通过，已自动退回执行 agent";
  const list = failed.slice(0, 5).map((f) => clipText(f.text, 120));
  return list.length ? `${head}：${list.join("；")}${failed.length > list.length ? `（另有 ${failed.length - list.length} 项）` : ""}` : head;
}

export function createPipeline(deps: PipelineDeps) {
  const { board, verify, registry, runner } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m, e) => console.error(`[vibe-verify] ${m}`, e ?? ""));
  const tuning = deps.tuning ?? defaultTuning;
  const prompts = deps.prompts ?? defaultPrompts;
  const pick = deps.pickVerifier ?? pickProvider(() => tuning().preferDifferentProvider);
  const active = new Set<string>();

  /** Length of the newest-first run of reject events that were caused by a model review. */
  const reviewReturnsInARow = (cardId: string) => {
    let n = 0;
    for (const e of board.events.list(cardId).reverse()) {
      if (e.type !== "reject") continue;
      if ((e.body as { reviewReturn?: boolean } | null)?.reviewReturn) n++;
      else break;
    }
    return n;
  };

  /** The card's single plan (WP-105), as the plan version shape the prompts read; old cards: newest version. */
  const planOf = (card: CardView): PlanVersion | undefined =>
    card.plan
      ? { id: "", cardId: card.id, version: 0, snapshot: card.plan, createdAt: card.updatedAt }
      : board.plans.list(card.id).at(-1);

  /**
   * Model review of the change by the card's reviewer preset. WP-105 order: execution -> review ->
   * evidence verification. The review runs first; severe findings return the card to the executor
   * at once (the evidence round is skipped, it would verify code that is about to change). Findings
   * become verification items of kind "review".
   */
  async function runReview(input: {
    card: CardView;
    project: Project;
    worktree: string;
    commitHash: string;
    vid: string;
    outputDir: string;
    notes: string[];
    allowReturn: boolean;
  }): Promise<void> {
    const { card, vid, notes } = input;
    const preset = board.presets.list().find((p) => p.id === card.reviewerPresetId);
    const doubt = (text: string) => {
      const item = verify.addItem(vid, { text: "Model review", method: "review", kind: "review" });
      verify.judgeItem(item.id, "doubt", text);
      notes.push(`Review: ${text}`);
    };
    const publish = (type: "review.started" | "review.finished", payload: object) =>
      publishEvent(
        board.db,
        { type, cardId: card.id, projectId: input.project.id, payload } as never,
        now,
      );
    let reviewerAgentId: string | undefined;
    const finish = (
      verdict: "pass" | "issues" | "severe",
      issues: string[],
      summary: string,
      sessionId?: string,
      failure?: string,
    ) => {
      publish("review.finished", {
        verdict,
        issues,
        summary,
        reviewerPresetId: card.reviewerPresetId,
        sessionId,
        verificationId: vid,
      });
      // The conclusion also goes to the card's group chat (idempotent per verification).
      try {
        board.cards.addChat({
          cardId: card.id,
          authorKind: "reviewer",
          author: preset?.name ?? "reviewer",
          kind: "verdict",
          thread: "review",
          text: reviewChatText(verdict, summary, issues, failure),
          agentId: reviewerAgentId,
          sessionId,
          key: `review:${vid}`,
        });
      } catch (e) {
        log("could not write the review conclusion to the chat", e);
      }
    };
    if (!preset) {
      doubt("The reviewer preset no longer exists");
      finish("issues", ["Reviewer preset missing"], "Review skipped", undefined, "复核预设已不存在");
      return;
    }

    const worker = workerSession(card.id);
    let agent: Awaited<ReturnType<VerifierLauncher["launch"]>> | undefined;
    let sessionId: string | undefined;
    try {
      agent = await deps.launcher.launch({
        card,
        project: input.project,
        provider: preset.provider,
        model: preset.model || undefined,
        cwd: input.worktree,
        workspaceId: worker?.workspaceId ?? null,
        outputDir: input.outputDir,
        role: "reviewer",
      });
      reviewerAgentId = agent.agentId;
      if (agent.note) notes.push(`Review: ${agent.note}`);
      sessionId = board.sessions.start({
        cardId: card.id,
        agentId: agent.agentId,
        workspaceId: worker?.workspaceId ?? null,
        role: "verifier",
        provider: agent.provider,
      }).id;
      publish("review.started", {
        reviewerPresetId: preset.id,
        provider: preset.provider,
        model: preset.model || undefined,
        sessionId,
        commitHash: input.commitHash,
      });

      const change = await changeDiff(runner, input.worktree, [preset.baseBranch, "main", "master"]);
      const before = await snapshotTree(runner, input.worktree);
      const result = await agent.run(
        buildReviewPrompt({
          card,
          plan: planOf(card),
          worktree: input.worktree,
          commitHash: input.commitHash,
          baseCommit: change.base,
          stat: change.stat,
          diff: change.diff,
          truncated: change.truncated,
          prompts,
        }),
      );
      const after = await snapshotTree(runner, input.worktree);
      if (!sameSnapshot(before, after)) {
        doubt("The reviewer modified the code; its review is void");
        finish("issues", ["Reviewer modified the code"], "Review void", sessionId, "复核 agent 改动了代码，结论作废");
        return;
      }
      const raw = parseJsonLoose(result.text);
      const parsed = raw === undefined ? undefined : ReviewSchema.safeParse(raw);
      if (result.status !== "idle" || !parsed?.success) {
        const why =
          result.status !== "idle"
            ? `reviewer round ended with status ${result.status}`
            : "no valid review result";
        doubt(`Review could not be completed: ${why}`);
        finish("issues", [`Review could not be completed: ${why}`], "", sessionId, why);
        return;
      }
      const review = parsed.data;
      const issues: ReviewIssue[] =
        review.issues.length === 0 && review.verdict && review.verdict !== "pass"
          ? [
              {
                severity: review.verdict === "severe" ? "severe" : "major",
                text: review.summary || "The reviewer reported problems without details",
              },
            ]
          : review.issues;
      if (issues.length === 0) {
        const item = verify.addItem(vid, { text: "Model review", method: "review", kind: "review" });
        verify.judgeItem(item.id, "pass", review.summary);
      }
      for (const issue of issues) {
        const item = verify.addItem(vid, {
          text: issue.text,
          method: `review:${issue.severity}`,
          kind: "review",
        });
        verify.judgeItem(item.id, issueJudgement(issue.severity, input.allowReturn, tuning().severityMap), issueLocation(issue));
      }
      if (review.summary) notes.push(`Review: ${review.summary}`);
      const verdict = reviewVerdict({ ...review, issues });
      finish(
        verdict,
        issues.map((i) => [`[${i.severity}]`, issueLocation(i), i.text].filter(Boolean).join(" ")),
        review.summary,
        sessionId,
      );
      if (verdict === "severe" && !input.allowReturn && tuning().autoReturnOnFail) {
        notes.push(
          `Review: severe issues, but the card was already sent back ${tuning().maxReviewReturns} times because of reviews; left to the user`,
        );
        publishEvent(
          board.db,
          {
            type: "master.alert",
            cardId: card.id,
            projectId: input.project.id,
            payload: {
              kind: "review_loop",
              message: `${card.key}: the reviewer still reports severe issues after ${tuning().maxReviewReturns} automatic returns; please look at it yourself.`,
            },
            dedupeKey: `review-loop:${card.id}:${vid}`,
          },
          now,
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      doubt(`Review could not be completed: ${message}`);
      finish("issues", [`Review could not be completed: ${message}`], "", sessionId, message);
    } finally {
      if (agent) await agent.close().catch(() => undefined);
      if (sessionId) {
        try {
          board.sessions.setState(sessionId, "ended", { outcome: "completed" });
        } catch {
          // already ended by the lifecycle listener
        }
      }
    }
  }

  /** The card's verification model: its pick, else the project / global default (WP-108). */
  const verifierPreset = (card: CardView, project: Project) => {
    const { presetId } = resolveModel(
      "verifier",
      card,
      project,
      board.modelDefaults.global(),
      (id) => !!board.presets.get(id),
    );
    return presetId ? board.presets.get(presetId) : undefined;
  };

  const workerSession = (cardId: string) => {
    const workers = board.sessions.list({ cardId, role: "worker" });
    return workers.findLast((s) => s.state !== "ended") ?? workers.at(-1);
  };

  async function readJsonFile(file: string): Promise<unknown> {
    if (!existsSync(file)) return undefined;
    return parseJsonLoose(readFileSync(file, "utf8"));
  }

  async function run(cardRef: string): Promise<PipelineResult | undefined> {
    const card = board.cards.get(cardRef);
    if (!card || card.column !== "verifying") return undefined;
    if (active.has(card.id)) return undefined;
    active.add(card.id);
    try {
      return await runCard(card);
    } finally {
      active.delete(card.id);
    }
  }

  async function runCard(card: CardView): Promise<PipelineResult> {
    const project = board.projects.list(true).find((p) => p.id === card.projectId);
    if (!project) throw new Error(`Project not found for ${card.key}`);
    const worktree = card.worktree ?? project.repoPath;
    const commitHash = await headCommit(runner, worktree);
    const mode = card.needsEvidence ? "evidence" : "tests_only";
    const checks = splitChecks(card, planOf(card));
    const { verification, items } = verify.create({
      cardId: card.id,
      projectId: project.id,
      commitHash,
      mode,
      checks,
    });
    const vid = verification.id;
    const outputDir = verify.dirFor(vid, card.key);
    const notes: string[] = [];
    let voided = false;

    const ctx: CollectorContext = {
      cardId: card.id,
      verificationId: vid,
      projectType: project.projectType,
      projectPath: project.repoPath,
      worktreePath: worktree,
      commitHash,
      outputDir,
      runner,
      now,
      signal: deps.signal,
      log: (m) => log(m),
    };

    const addEvidence = (itemId: string | null, artifacts: EvidenceArtifact[]) =>
      artifacts.map((a) => verify.addEvidence(vid, itemId, a));
    const extraItem = (text: string, method: string, j: Judgement, note: string, art: EvidenceArtifact[]) => {
      const item = verify.addItem(vid, { text, method });
      const files = addEvidence(item.id, art);
      verify.judgeItem(item.id, j, note, files.map((f) => f.id));
      return item;
    };

    let baseline: Baseline | undefined;
    let verifierAgent: Awaited<ReturnType<VerifierLauncher["launch"]>> | undefined;
    let verifierSessionId: string | undefined;
    const names = new Map<string, string>(); // evidence file name -> evidence id

    // ---- model review first (optional, card.reviewerPresetId) ----------------------------
    let reviewReturns = false;
    if (card.reviewerPresetId) {
      const allowReturn = reviewReturnsInARow(card.id) < tuning().maxReviewReturns;
      await runReview({ card, project, worktree, commitHash, vid, outputDir, notes, allowReturn });
      reviewReturns =
        allowReturn &&
        tuning().autoReturnOnFail &&
        verify.items(vid).some((i) => i.kind === "review" && i.judgement === "fail");
      if (reviewReturns) notes.push("复核发现严重问题：退回执行模型修改，本轮跳过证据验证。");
    }

    try {
      if (!reviewReturns) {
        // ---- verifier agent (both modes, WP-108) ----------------------------------------
        const worker = workerSession(card.id);
        const chosen = verifierPreset(card, project);
        const choice = chosen
          ? { provider: chosen.provider, model: chosen.model || undefined }
          : pick({
              card,
              project,
              workerProvider: worker?.currentProvider ?? null,
              presets: board.presets.list(),
            });
        if (chosen) notes.push(`验证模型：${chosen.name}（${chosen.provider}/${chosen.model}）`);
        else notes.push(`没有选验证模型（卡片、项目、全局都没有），自动挑选了 ${choice.provider}`);
        let launchError: string | undefined;
        try {
          verifierAgent = await deps.launcher.launch({
            card,
            project,
            provider: choice.provider,
            model: choice.model,
            cwd: worktree,
            workspaceId: worker?.workspaceId ?? null,
            outputDir,
          });
          if (verifierAgent.note) notes.push(verifierAgent.note);
          verify.setVerifier(vid, verifierAgent.agentId);
          verifierSessionId = board.sessions.start({
            cardId: card.id,
            agentId: verifierAgent.agentId,
            workspaceId: worker?.workspaceId ?? null,
            role: "verifier",
            provider: verifierAgent.provider,
          }).id;
        } catch (e) {
          launchError = e instanceof Error ? e.message : String(e);
          notes.push(`Verifier agent could not be started: ${launchError}`);
        }

        // Runs one verifier round; the tree must be identical before and after.
        const guarded = async (prompt: string) => {
          if (!verifierAgent) return undefined;
          const before = await snapshotTree(runner, worktree);
          const result = await verifierAgent.run(prompt);
          const after = await snapshotTree(runner, worktree);
          if (!sameSnapshot(before, after)) {
            voided = true;
            notes.push("Verifier modified the code; the evidence of this run is void.");
          }
          if (result.status !== "idle") {
            notes.push(`Verifier round ended with status ${result.status}${result.error ? `: ${result.error}` : ""}`);
          }
          return result;
        };
        let judgeReply = "";
        if (mode === "evidence") {
        let setupReply = "";

        // ---- round 1: how to run it -----------------------------------------------------
        const existingPerf = readExistingPerf(worktree);
        if (project.projectType === "web" || existingPerf) {
          const base = await prepareBaseline(
            runner,
            worktree,
            path.join(tuning().worktreeRoot || deps.worktreeRoot, `verify-${card.key.toLowerCase()}-${vid.slice(-6).toLowerCase()}`),
            [board.presets.list().find((p) => p.id === card.presetId)?.baseBranch, "main", "master"],
          );
          if (base) baseline = base;
          else notes.push("No baseline commit available: before/after comparison skipped");
        }
        const existing = existsSync(path.join(worktree, ".vibe", "verify.json"));
        let config: VerifyConfig = {};
        if (verifierAgent) {
          setupReply = (await guarded(
            buildSetupPrompt({
              card,
              projectType: project.projectType,
              worktree,
              commitHash,
              outputDir,
              checks,
              baselinePath: baseline?.path,
              baselineCommit: baseline?.commitHash,
              existingConfig: existing,
              prompts,
            }),
          ))?.text ?? "";
          const raw = parseJsonLoose(setupReply) ?? (await readJsonFile(path.join(outputDir, "verify.json")));
          if (raw !== undefined) {
            const parsed = VerifyConfigSchema.safeParse(raw);
            if (parsed.success) config = parsed.data;
            else notes.push(`verify.json written by the verifier is invalid: ${parsed.error.message.slice(0, 300)}`);
          } else {
            notes.push("The verifier returned no verify config; falling back to .vibe/verify.json of the worktree");
          }
        }
        if (baseline && config.web && !config.web.baseline) {
          config = {
            ...config,
            web: { ...config.web, baseline: { path: baseline.path, commitHash: baseline.commitHash } },
          };
        }
        if (existingPerf && !config.backend?.perf) {
          config = { ...config, backend: { ...config.backend, requests: config.backend?.requests ?? [], perf: existingPerf } };
        }
        if (baseline && config.backend?.perf && !config.backend.perf.baseline) {
          config = {
            ...config,
            backend: {
              ...config.backend,
              perf: { ...config.backend.perf, baseline: { path: baseline.path, commitHash: baseline.commitHash } },
            },
          };
        }
        deps.configs.set(vid, config);

        // ---- collectors -----------------------------------------------------------------
        let backendRan = false;
        const checkIds = [...new Set((config.backend?.requests ?? []).flatMap((r) => (r.checkId ? [r.checkId] : [])))];
        for (const collector of registry.forProjectType(project.projectType)) {
          try {
            const availability = await collector.detect(ctx);
            if (!availability.available) {
              notes.push(`${collector.id}: unavailable (${availability.reason ?? "unknown reason"})`);
              continue;
            }
            const runOne = async (check?: { id: string; text: string; method: string }) => {
              const res = await collector.collect({ ...ctx, check });
              const notesText = [...res.notes, ...(res.degraded ? ["(degraded fallback used)"] : [])].join("; ");
              const item = extraItem(
                check ? `Evidence: ${collector.id} for check ${check.id}` : `Evidence: ${collector.id}`,
                "auto",
                res.judgement ?? "doubt",
                notesText,
                [],
              );
              const stored = addEvidence(item.id, res.artifacts);
              verify.judgeItem(item.id, res.judgement ?? "doubt", notesText, stored.map((s) => s.id));
              for (const [i, a] of res.artifacts.entries()) names.set(path.basename(a.path), stored[i]!.id);
            };
            await runOne();
            if (collector.id === "backend") backendRan = true;
            for (const id of checkIds) {
              const spec = checks[Number(id) - 1];
              if (spec) await runOne({ id, ...spec });
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            extraItem(`Evidence: ${collector.id}`, "auto", "doubt", `Collector failed: ${message}`, []);
          } finally {
            await collector.dispose?.(ctx).catch((e) => log(`dispose ${collector.id} failed`, e));
          }
        }

        // ---- automatic tests/lint (tests are skipped when the backend collector ran them) --
        for (const auto of await runAutoChecks(ctx, runner, { skipTests: backendRan })) {
          extraItem(auto.text, auto.method, auto.judgement, auto.note, auto.artifacts);
        }
        } else {
          // ---- tests_only: the automatic tests/lint are the evidence ----------------------
          for (const auto of await runAutoChecks(ctx, runner)) {
            const item = extraItem(auto.text, auto.method, auto.judgement, auto.note, auto.artifacts);
            for (const file of verify.evidence(vid).filter((e) => e.itemId === item.id)) {
              names.set(path.basename(file.path), file.id);
            }
          }
          if (!verify.items(vid).some((i) => i.method.startsWith("auto"))) {
            notes.push("No test or lint command was found; the verifier judges the checks without them");
          }
        }

        // ---- round 2: judge the evidence ------------------------------------------------
        if (verifierAgent) {
          const evidence = verify.evidence(vid);
          judgeReply = (await guarded(
            buildJudgePrompt({
              card,
              checks,
              commitHash,
              outputDir,
              prompts,
              evidence: evidence.map((e) => ({
                name: path.basename(e.path),
                kind: e.kind,
                excerpt: textExcerpt(e.path, e.kind, tuning().excerptChars),
              })),
              notes: verify
                .items(vid)
                .filter((i) => i.method.startsWith("auto") && i.note)
                .map((i) => `${i.checkText}: ${i.note}`),
            }),
          ))?.text ?? "";
          const raw = parseJsonLoose(judgeReply) ?? (await readJsonFile(path.join(outputDir, "verdict.json")));
          const parsed = raw === undefined ? undefined : VerdictSchema.safeParse(raw);
          if (parsed?.success) {
            for (const v of parsed.data.items) {
              const item = items[v.check - 1];
              if (!item) continue;
              verify.judgeItem(
                item.id,
                v.judgement,
                v.note,
                v.evidence.flatMap((n) => (names.get(n) ? [names.get(n)!] : [])),
              );
            }
          } else {
            notes.push("The verifier produced no valid verdict");
          }
        }
      }
    } catch (e) {
      notes.push(`Verification aborted: ${e instanceof Error ? e.message : String(e)}`);
      log(`${card.key} verification failed`, e);
    } finally {
      deps.configs.delete(vid);
      if (verifierAgent) await verifierAgent.close().catch(() => undefined);
      if (verifierSessionId) {
        try {
          board.sessions.setState(verifierSessionId, "ended", { outcome: "completed" });
        } catch {
          // already ended by the lifecycle listener
        }
      }
      if (baseline) {
        const problem = await removeWorktree(runner, worktree, baseline.path);
        if (problem) notes.push(`Baseline worktree ${baseline.path} was kept: ${problem}`);
      }
    }

    // ---- conclude -----------------------------------------------------------------------
    let finalItems = verify.items(vid);
    if (voided) {
      for (const item of finalItems) {
        if (item.judgement !== "fail" || !item.method.startsWith("auto")) {
          verify.judgeItem(item.id, "doubt", `${item.note ? `${item.note} ` : ""}[void: verifier modified the code]`);
        }
      }
      finalItems = verify.items(vid);
    }
    for (const item of finalItems) {
      if (item.judgement === null) verify.judgeItem(item.id, "doubt", item.note || "No judgement was produced");
    }
    finalItems = verify.items(vid);
    const conclusion = aggregate(finalItems.map((i) => i.judgement));
    verify.writeNotes(vid, notes);
    verify.finish(vid, conclusion, project.id);

    const failed = finalItems.filter((i) => i.judgement === "fail");
    board.events.add({
      cardId: card.id,
      type: "status",
      authorKind: "system",
      author: "verifier",
      body: {
        kind: "verification",
        verificationId: vid,
        conclusion,
        voided,
        text: verificationLine(conclusion, finalItems, commitHash, voided),
      },
    });

    let returned = false;
    if (conclusion === "fail" && !voided && tuning().autoReturnOnFail) {
      returned = await sendBack(card.id, {
        verificationId: vid,
        commitHash,
        failed: failed.map((i) => toFailed(i, verify.evidence(vid))),
        source: "verifier",
        review: failed.some((i) => i.kind === "review"),
      });
    }
    return { verificationId: vid, conclusion, voided, returned };
  }

  function toFailed(item: VerificationItem, evidence: ReturnType<VerifyStore["evidence"]>): FailedItem {
    const own = evidence.filter((e) => item.evidenceIds.includes(e.id) || e.itemId === item.id);
    const severity = item.method.startsWith("review:") ? `[${item.method.slice(7)}] ` : "";
    return { text: `${severity}${item.checkText}`, note: item.note, evidenceFiles: own.map((e) => e.path) };
  }

  /** verifying -> in_progress and the failure text to the original worker session. */
  async function sendBack(
    cardId: string,
    input: {
      verificationId: string;
      commitHash: string;
      failed: FailedItem[];
      source: "verifier" | "user";
      comment?: string;
      /** A model review (not only a failed check) caused the return. */
      review?: boolean;
    },
  ): Promise<boolean> {
    const card = board.cards.get(cardId);
    if (!card || card.column !== "verifying") return false;
    const prompt = buildFailurePrompt({ card, ...input, prompts });
    board.cards.move(card.id, {
      to: "in_progress",
      actor: input.source === "user" ? "user" : "verifier",
      reason:
        input.source === "user"
          ? "user rejected"
          : input.review
            ? "review found severe issues"
            : "verification failed",
    });
    board.events.add({
      cardId: card.id,
      type: "reject",
      authorKind: input.source === "user" ? "user" : "system",
      author: input.source === "user" ? "user" : "verifier",
      body: {
        text: input.comment ?? returnReason(input.review === true, input.failed),
        verificationId: input.verificationId,
        prompt,
        ...(input.review ? { reviewReturn: true } : {}),
      },
    });
    const worker = workerSession(card.id);
    let delivered = false;
    if (worker && worker.state !== "ended") {
      delivered = await deps.notifyWorker(worker.agentId, prompt).catch((e) => {
        log("notifying the worker failed", e);
        return false;
      });
    }
    if (!delivered) {
      board.events.add({
        cardId: card.id,
        type: "status",
        authorKind: "system",
        author: "verifier",
        body: {
          kind: "worker_unreachable",
          text: "The worker session is gone; re-dispatch the card to continue. The failure prompt is in the previous event.",
        },
      });
    }
    return delivered;
  }

  /** User rejection with one sentence. */
  async function reject(cardRef: string, comment: string): Promise<boolean> {
    const card = board.cards.get(cardRef);
    if (!card) throw new Error(`Card not found: ${cardRef}`);
    const latest = verify.latest(card.id);
    const failed = latest
      ? verify
          .items(latest.id)
          .filter((i) => i.judgement === "fail")
          .map((i) => toFailed(i, verify.evidence(latest.id)))
      : [];
    return sendBack(card.id, {
      verificationId: latest?.id ?? "",
      commitHash: latest?.commitHash ?? "",
      failed,
      source: "user",
      comment,
    });
  }

  function approve(cardRef: string) {
    const card = board.cards.get(cardRef);
    if (!card) throw new Error(`Card not found: ${cardRef}`);
    board.cards.move(card.id, { to: "done", actor: "user", reason: "verification accepted" });
  }

  return { run, reject, approve, isRunning: (cardId: string) => active.has(cardId) };
}

export type Pipeline = ReturnType<typeof createPipeline>;
