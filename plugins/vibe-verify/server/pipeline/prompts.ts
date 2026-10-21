// Prompts: the two verifier rounds and the "sent back" message for the worker. The texts live in the
// prompt registry (../prompts/defs.ts, editable on the Agent behaviour page); here only the
// per-run values are prepared.

import type { CardView, ProjectType } from "../vibe/contract";
import { defaultPrompts, type PromptResolver } from "../prompts";
import type { CheckSpec } from "./checks";

export { verifyConfigDoc } from "../prompts/defs";

/** Where a builder takes its text from: the registry (with project overrides) or the registered defaults. */
export interface PromptSource {
  prompts?: PromptResolver;
}

const numbered = (checks: readonly CheckSpec[]) =>
  checks.map((c, i) => `${i + 1}. ${c.text}${c.method ? `  (how: ${c.method})` : ""}`).join("\n");

export interface SetupPromptInput extends PromptSource {
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
  return (i.prompts ?? defaultPrompts).resolve("verify.setup", {
    projectId: i.card.projectId,
    vars: {
      "card.key": i.card.key,
      projectType: i.projectType,
      worktree: i.worktree,
      commitHash: i.commitHash,
      baselineLine: i.baselinePath
        ? `Baseline worktree (the code before the change, commit ${i.baselineCommit}): ${i.baselinePath}`
        : "No baseline worktree is available.",
      "card.title": i.card.title,
      description: i.card.description || "",
      checks: numbered(i.checks),
      baselineHint: i.baselinePath
        ? "Put the baseline path above in web.baseline.path when the project is a web app."
        : "",
      existingConfigNote: i.existingConfig
        ? "The repository already contains .vibe/verify.json; read it, and write a corrected copy if it needs changes, otherwise write it unchanged."
        : "",
    },
  });
}

export interface EvidenceLine {
  name: string;
  label?: string;
  kind: string;
  /** Text content of small log/report files, inlined because the verifier cannot read outside the worktree. */
  excerpt?: string;
}

function evidenceLine(e: EvidenceLine): string {
  const head = `- ${e.name} [${e.kind}]${e.label ? ` - ${e.label}` : ""}`;
  if (!e.excerpt) return head;
  const body = e.excerpt.split("\n").map((l) => `    | ${l}`);
  return [head, ...body].join("\n");
}

export interface JudgePromptInput extends PromptSource {
  card: CardView;
  checks: readonly CheckSpec[];
  commitHash: string;
  outputDir: string;
  evidence: readonly EvidenceLine[];
  notes: readonly string[];
}

export function buildJudgePrompt(i: JudgePromptInput): string {
  return (i.prompts ?? defaultPrompts).resolve("verify.judge", {
    projectId: i.card.projectId,
    vars: {
      "card.key": i.card.key,
      commitHash: i.commitHash,
      outputDir: i.outputDir,
      checks: numbered(i.checks),
      evidence: i.evidence.length ? i.evidence.map(evidenceLine).join("\n") : "- none",
      notes: i.notes.length ? i.notes.map((n) => `- ${n}`).join("\n") : "- none",
    },
  });
}

export interface FailedItem {
  text: string;
  note: string;
  evidenceFiles: string[];
}

export function buildFailurePrompt(
  input: PromptSource & {
    card: CardView;
    commitHash: string;
    source: "verifier" | "user";
    failed: readonly FailedItem[];
    comment?: string;
    review?: boolean;
  },
): string {
  const key =
    input.source === "user"
      ? "verify.send_back.user"
      : input.review
        ? "verify.send_back.review"
        : "verify.send_back.verifier";
  const failed = input.failed
    .map(
      (f) =>
        `- ${f.text}\n  Finding: ${f.note || "(no note)"}${
          f.evidenceFiles.length ? `\n  Evidence: ${f.evidenceFiles.join(", ")}` : ""
        }`,
    )
    .join("\n");
  return (input.prompts ?? defaultPrompts).resolve(key, {
    projectId: input.card.projectId,
    vars: {
      "card.key": input.card.key,
      commitHash: input.commitHash,
      comment: input.comment ? `User comment: ${input.comment}\n\n` : "",
      failed: failed ? `Failed checks:\n${failed}\n\n` : "",
    },
  });
}
