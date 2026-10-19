// Prompts: the two verifier rounds and the "sent back" message for the worker.

import { z } from "zod";
import { VerifyConfigSchema } from "../collectors/common";
import type { CardView, ProjectType } from "../vibe/contract";
import type { CheckSpec } from "./checks";

export function verifyConfigDoc(): string {
  try {
    return JSON.stringify(z.toJSONSchema(VerifyConfigSchema, { io: "input" }));
  } catch {
    return "(schema unavailable: use the sections web, backend, android as documented in plugins/vibe-verify/README.md)";
  }
}

const numbered = (checks: readonly CheckSpec[]) =>
  checks.map((c, i) => `${i + 1}. ${c.text}${c.method ? `  (how: ${c.method})` : ""}`).join("\n");

export interface SetupPromptInput {
  card: CardView;
  projectType: ProjectType;
  worktree: string;
  commitHash: string;
  outputDir: string;
  checks: readonly CheckSpec[];
  baselinePath?: string;
  baselineCommit?: string;
  existingConfig: boolean;
}

export function buildSetupPrompt(i: SetupPromptInput): string {
  return `# Verify ${i.card.key} (${i.projectType} project) - round 1: how to run it

Worktree under test (READ-ONLY for you): ${i.worktree}
Commit: ${i.commitHash}
Output directory (the only place you may write): ${i.outputDir}
${i.baselinePath ? `Baseline worktree (the code before the change, commit ${i.baselineCommit}): ${i.baselinePath}` : "No baseline worktree is available."}

## Card
${i.card.title}

${i.card.description || ""}

## Checks (numbered)
${numbered(i.checks)}

## Your task
Read the code and decide how an evidence collector should run this project and exercise each check (start command + ready URL, pages and click/fill steps, HTTP requests, Android app/flow, test command). Write ONE JSON file ${i.outputDir}/verify.json that follows this JSON Schema (only include the sections that apply; omit everything you cannot determine):
${verifyConfigDoc()}

Use the check number as string in \`checkId\` of backend requests (for example "1"). Use paths relative to the worktree for \`cwd\`. ${i.baselinePath ? `Put the baseline path above in web.baseline.path when the project is a web app.` : ""}
${i.existingConfig ? "The repository already contains .vibe/verify.json; read it, and write a corrected copy if it needs changes, otherwise write it unchanged." : ""}
Do not modify anything in the worktree. Reply with one short sentence when the file is written.`;
}

export interface EvidenceLine {
  name: string;
  label?: string;
  kind: string;
}

export interface JudgePromptInput {
  card: CardView;
  checks: readonly CheckSpec[];
  commitHash: string;
  outputDir: string;
  evidence: readonly EvidenceLine[];
  notes: readonly string[];
}

export function buildJudgePrompt(i: JudgePromptInput): string {
  return `# Verify ${i.card.key} - round 2: judge the evidence

Commit under test: ${i.commitHash}
Evidence directory: ${i.outputDir}

## Checks (numbered)
${numbered(i.checks)}

## Collected evidence (files in the evidence directory)
${i.evidence.length ? i.evidence.map((e) => `- ${e.name} [${e.kind}]${e.label ? ` - ${e.label}` : ""}`).join("\n") : "- none"}

## Collector notes
${i.notes.length ? i.notes.map((n) => `- ${n}`).join("\n") : "- none"}

## Your task
Open the evidence (look at screenshots and read logs and reports), compare it with the code and each check, and judge every check: "pass" (clearly satisfied), "doubt" (cannot tell from the evidence) or "fail" (not satisfied or broken). Be strict; do not give "pass" without evidence. Write ONE JSON file ${i.outputDir}/verdict.json:
{"summary": "one sentence", "items": [{"check": 1, "judgement": "pass|doubt|fail", "note": "why, one or two sentences", "evidence": ["file names from the list above"]}]}
Include every check number. Do not modify anything outside the evidence directory. Reply with one short sentence when the file is written.`;
}

export interface FailedItem {
  text: string;
  note: string;
  evidenceFiles: string[];
}

export function buildFailurePrompt(input: {
  card: CardView;
  commitHash: string;
  source: "verifier" | "user";
  failed: readonly FailedItem[];
  comment?: string;
}): string {
  const head =
    input.source === "user"
      ? `Your work on ${input.card.key} was rejected by the user.`
      : `Independent verification of ${input.card.key} (commit ${input.commitHash}) found failing checks, so the card was sent back to you.`;
  const body = input.failed.length
    ? input.failed
        .map(
          (f) =>
            `- ${f.text}\n  Finding: ${f.note || "(no note)"}${
              f.evidenceFiles.length ? `\n  Evidence: ${f.evidenceFiles.join(", ")}` : ""
            }`,
        )
        .join("\n")
    : "";
  return [
    head,
    input.comment ? `User comment: ${input.comment}` : "",
    body ? `Failed checks:\n${body}` : "",
    "Fix the problems, run the project's tests, and finish your round; the card will be verified again.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
