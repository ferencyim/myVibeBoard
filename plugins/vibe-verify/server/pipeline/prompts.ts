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
  checks.map((c, i) => `${i + 1}. ${c.text}${c.method ? `  （做法：${c.method}）` : ""}`).join("\n");

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
        ? `基线工作树（改动前的代码，提交 ${i.baselineCommit}）：${i.baselinePath}`
        : "没有可用的基线工作树。",
      "card.title": i.card.title,
      description: i.card.description || "",
      checks: numbered(i.checks),
      baselineHint: i.baselinePath
        ? "如果项目是 web 应用，请把上面的基线路径写进 web.baseline.path。"
        : "",
      existingConfigNote: i.existingConfig
        ? "仓库里已有 .vibe/verify.json：请先读它；需要修改时在回复的 JSON 里给出修正后的内容，不需要时原样给出。"
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
      evidence: i.evidence.length ? i.evidence.map(evidenceLine).join("\n") : "- 无",
      notes: i.notes.length ? i.notes.map((n) => `- ${n}`).join("\n") : "- 无",
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
        `- ${f.text}\n  发现：${f.note || "（无说明）"}${
          f.evidenceFiles.length ? `\n  证据：${f.evidenceFiles.join(", ")}` : ""
        }`,
    )
    .join("\n");
  return (input.prompts ?? defaultPrompts).resolve(key, {
    projectId: input.card.projectId,
    vars: {
      "card.key": input.card.key,
      commitHash: input.commitHash,
      comment: input.comment ? `用户评论：${input.comment}\n\n` : "",
      failed: failed ? `未通过的检查：\n${failed}\n\n` : "",
    },
  });
}
