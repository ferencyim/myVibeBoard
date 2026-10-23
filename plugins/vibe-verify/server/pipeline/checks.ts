import type { CollectorContext } from "../collectors/context";
// Check items (from the card) and the always-on automatic checks: tests and lint.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CardView, EvidenceArtifact, Judgement, PlanVersion, Runner } from "../vibe/contract";
import { loadVerifyConfig, writeArtifact } from "../collectors/common";
import { resolveTestCommand } from "../collectors/backend";

export interface CheckSpec {
  text: string;
  method: string;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/;

/** Latest plan checks, else acceptance criteria one per line, else the card title. */
export function splitChecks(card: CardView, plan?: PlanVersion): CheckSpec[] {
  const planned = plan?.snapshot.checks.filter((c) => c.text.trim());
  if (planned?.length) return planned.map((c) => ({ text: c.text.trim(), method: c.method ?? "" }));
  const lines = card.acceptance
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, "").trim())
    .filter(Boolean);
  if (lines.length) return lines.map((text) => ({ text, method: "" }));
  return [{ text: `The change does what the card asks: ${card.title}`, method: "" }];
}

export interface AutoCheck extends CheckSpec {
  kind: "tests" | "lint";
  judgement: Judgement;
  note: string;
  artifacts: EvidenceArtifact[];
}

function lintCommand(worktree: string): { command: string; args: string[] } | undefined {
  const file = path.join(worktree, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts?.lint ? { command: "npm", args: ["run", "lint"] } : undefined;
  } catch {
    return undefined;
  }
}

function testCommand(worktree: string) {
  try {
    return resolveTestCommand(loadVerifyConfig(worktree), worktree);
  } catch {
    return undefined;
  }
}

const tail = (text: string, max = 100_000) =>
  text.length <= max ? text : `[truncated ${text.length - max} chars]...\n${text.slice(-max)}`;

export interface AutoCheckOptions {
  /** Skip the test run because a collector (backend) runs the tests as part of its evidence. */
  skipTests?: boolean;
  timeoutMs?: number;
}

/** Runs the project's tests and lint when it has them. Nothing detectable = no item. */
export async function runAutoChecks(
  ctx: CollectorContext,
  runner: Runner,
  options: AutoCheckOptions = {},
): Promise<AutoCheck[]> {
  const jobs = [
    {
      kind: "tests" as const,
      text: "测试通过",
      cmd: options.skipTests ? undefined : testCommand(ctx.worktreePath),
    },
    { kind: "lint" as const, text: "Lint 检查通过", cmd: lintCommand(ctx.worktreePath) },
  ];
  const results: AutoCheck[] = [];
  for (const job of jobs) {
    if (!job.cmd) continue;
    const cmdline = [job.cmd.command, ...job.cmd.args].join(" ");
    const run = await runner.run(job.cmd.command, job.cmd.args, {
      cwd: ctx.worktreePath,
      timeoutMs: options.timeoutMs ?? 600_000,
      signal: ctx.signal,
    });
    const passed = run.exitCode === 0 && !run.timedOut;
    const log = writeArtifact(
      ctx,
      "log",
      `auto-${job.kind}.log`,
      tail(`$ ${cmdline}\n${run.stdout}${run.stderr ? `\n--- stderr ---\n${run.stderr}` : ""}`),
      `${job.kind}: ${cmdline}`,
    );
    results.push({
      kind: job.kind,
      text: job.text,
      method: `auto: ${cmdline}`,
      judgement: passed ? "pass" : "fail",
      note: run.timedOut
        ? `${cmdline} 超时`
        : `${cmdline} 退出码 ${run.exitCode}，耗时 ${run.durationMs}ms`,
      artifacts: [log],
    });
  }
  return results;
}
