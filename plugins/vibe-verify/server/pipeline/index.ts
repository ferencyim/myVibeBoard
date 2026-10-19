// Verification pipeline (WP-20). Triggered when a card reaches `verifying`:
//
//   evidence mode  : verifier agent round 1 (writes verify.json) -> collectors from the registry
//                    -> automatic tests/lint -> verifier round 2 (judges the evidence per check)
//   tests_only mode: automatic tests + lint only
//
// then aggregate (fail > doubt > pass), store, and on failure send the card back to `in_progress`
// (actor verifier) with the failing evidence as the worker's next prompt.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type CardView,
  type CollectorContext,
  type CollectorRegistry,
  type EvidenceArtifact,
  type Judgement,
  type Runner,
  type VerificationItem,
} from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { VerifyConfigSchema, type VerifyConfig } from "../collectors/common";
import { type VerifierLauncher, type PickVerifier, VerdictSchema, parseJsonLoose, pickDifferentProvider } from "../verifier/agent";
import { aggregate, SUMMARY, type VerifyStore } from "../store";
import { runAutoChecks, splitChecks } from "./checks";
import { prepareBaseline, type Baseline, removeWorktree, sameSnapshot, snapshotTree, headCommit } from "./git";
import { buildFailurePrompt, buildJudgePrompt, buildSetupPrompt, type FailedItem } from "./prompts";
import type { RunConfigs } from "../registry";

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
  /** Where baseline worktrees are created (Windows: must be on D:). */
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

export function createPipeline(deps: PipelineDeps) {
  const { board, verify, registry, runner } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m, e) => console.error(`[vibe-verify] ${m}`, e ?? ""));
  const pick = deps.pickVerifier ?? pickDifferentProvider;
  const active = new Set<string>();

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
    const plan = board.plans.list(card.id).at(-1);
    const checks = mode === "evidence" ? splitChecks(card, plan) : [];
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

    try {
      if (mode === "evidence") {
        // ---- verifier agent -------------------------------------------------------------
        const worker = workerSession(card.id);
        const choice = pick({
          card,
          project,
          workerProvider: worker?.currentProvider ?? null,
          presets: board.presets.list(),
        });
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

        // ---- round 1: how to run it -----------------------------------------------------
        if (project.projectType === "web") {
          const base = await prepareBaseline(
            runner,
            worktree,
            path.join(deps.worktreeRoot, `verify-${card.key.toLowerCase()}-${vid.slice(-6).toLowerCase()}`),
            [board.presets.list().find((p) => p.id === card.presetId)?.baseBranch, "main", "master"],
          );
          if (base) baseline = base;
          else notes.push("No baseline commit available: before/after comparison skipped");
        }
        const existing = existsSync(path.join(worktree, ".vibe", "verify.json"));
        let config: VerifyConfig = {};
        if (verifierAgent) {
          await guarded(
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
            }),
          );
          const raw = await readJsonFile(path.join(outputDir, "verify.json"));
          if (raw !== undefined) {
            const parsed = VerifyConfigSchema.safeParse(raw);
            if (parsed.success) config = parsed.data;
            else notes.push(`verify.json written by the verifier is invalid: ${parsed.error.message.slice(0, 300)}`);
          } else {
            notes.push("The verifier wrote no verify.json; falling back to .vibe/verify.json of the worktree");
          }
        }
        if (baseline && config.web && !config.web.baseline) {
          config = {
            ...config,
            web: { ...config.web, baseline: { path: baseline.path, commitHash: baseline.commitHash } },
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

        // ---- round 2: judge the evidence ------------------------------------------------
        if (verifierAgent) {
          const evidence = verify.evidence(vid);
          await guarded(
            buildJudgePrompt({
              card,
              checks,
              commitHash,
              outputDir,
              evidence: evidence.map((e) => ({ name: path.basename(e.path), kind: e.kind })),
              notes: verify
                .items(vid)
                .filter((i) => i.method === "auto" && i.note)
                .map((i) => `${i.checkText}: ${i.note}`),
            }),
          );
          const raw = await readJsonFile(path.join(outputDir, "verdict.json"));
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
            notes.push("The verifier produced no valid verdict.json");
          }
        }
      } else {
        for (const auto of await runAutoChecks(ctx, runner)) {
          extraItem(auto.text, auto.method, auto.judgement, auto.note, auto.artifacts);
        }
        if (verify.items(vid).length === 0) notes.push("No test or lint command was found; nothing could be checked");
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
        text: `${SUMMARY[conclusion]} (${commitHash.slice(0, 8)})${voided ? " - verifier modified the code, evidence void" : ""}`,
      },
    });

    let returned = false;
    if (conclusion === "fail" && !voided) {
      returned = await sendBack(card.id, {
        verificationId: vid,
        commitHash,
        failed: failed.map((i) => toFailed(i, verify.evidence(vid))),
        source: "verifier",
      });
    }
    return { verificationId: vid, conclusion, voided, returned };
  }

  function toFailed(item: VerificationItem, evidence: ReturnType<VerifyStore["evidence"]>): FailedItem {
    const own = evidence.filter((e) => item.evidenceIds.includes(e.id) || e.itemId === item.id);
    return { text: item.checkText, note: item.note, evidenceFiles: own.map((e) => e.path) };
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
    },
  ): Promise<boolean> {
    const card = board.cards.get(cardId);
    if (!card || card.column !== "verifying") return false;
    const prompt = buildFailurePrompt({ card, ...input });
    board.cards.move(card.id, {
      to: "in_progress",
      actor: input.source === "user" ? "user" : "verifier",
      reason: input.source === "user" ? "user rejected" : "verification failed",
    });
    board.events.add({
      cardId: card.id,
      type: "reject",
      authorKind: input.source === "user" ? "user" : "system",
      author: input.source === "user" ? "user" : "verifier",
      body: { text: input.comment ?? "Verification failed", verificationId: input.verificationId, prompt },
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
