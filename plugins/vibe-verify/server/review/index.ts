// Model code review of a card (WP-80). A second, read-only agent on the card's reviewer preset
// reads the diff and returns structured issues. The pipeline turns them into verification items
// (kind=review): severe -> fail (card is sent back), major/minor -> doubt, none -> pass.

import { z } from "zod";
import type { CardView, Judgement, PlanVersion } from "../vibe/contract";

export const ISSUE_SEVERITIES = ["severe", "major", "minor"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

const SEVERITY_RANK: Record<IssueSeverity, number> = { severe: 2, major: 1, minor: 0 };

export const ReviewSchema = z.object({
  verdict: z.enum(["pass", "issues", "severe"]).optional(),
  summary: z.string().default(""),
  issues: z
    .array(
      z.object({
        severity: z.enum(ISSUE_SEVERITIES),
        file: z.string().nullish(),
        line: z.number().int().nullish(),
        text: z.string().min(1),
      }),
    )
    .default([]),
});
export type Review = z.infer<typeof ReviewSchema>;
export type ReviewIssue = Review["issues"][number];

/** The stricter of what the reviewer declared and what its issue list implies. */
export function reviewVerdict(review: Review): "pass" | "issues" | "severe" {
  const worst = review.issues.reduce<IssueSeverity | undefined>(
    (w, i) => (w === undefined || SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w),
    undefined,
  );
  if (worst === "severe" || review.verdict === "severe") return "severe";
  if (worst || review.verdict === "issues") return "issues";
  return "pass";
}

/** `severe` is a fail unless the return budget is used up (then it is only doubtful). */
export function issueJudgement(severity: IssueSeverity, allowReturn: boolean): Judgement {
  return severity === "severe" && allowReturn ? "fail" : "doubt";
}

export const REVIEWER_SYSTEM_PROMPT = `You are an independent code reviewer for a kanban card. Another agent wrote the change; you did not.
You are READ-ONLY with respect to the repository: never edit, create, move or delete files in the working tree, never run git commands that change state, never install dependencies. You may read any file and run read-only commands (git diff, git log, grep). Review what the change actually does.`;

export interface ReviewPromptInput {
  card: CardView;
  plan?: PlanVersion;
  worktree: string;
  commitHash: string;
  baseCommit?: string;
  stat: string;
  diff: string;
  truncated: boolean;
}

export function buildReviewPrompt(i: ReviewPromptInput): string {
  const plan = i.plan?.snapshot;
  return `# Review ${i.card.key}: ${i.card.title}

Worktree (READ-ONLY for you): ${i.worktree}
Reviewed commit: ${i.commitHash}${i.baseCommit ? `  (diff against ${i.baseCommit})` : "  (no base commit found: uncommitted changes only)"}

## Card description
${i.card.description || "(none)"}

## Acceptance criteria
${i.card.acceptance || "(none)"}
${plan ? `\n## Latest plan\n${plan.description}\n${plan.checks.map((c, n) => `${n + 1}. ${c.text}`).join("\n")}${plan.notes ? `\nNotes: ${plan.notes}` : ""}\n` : ""}
## Diff summary
${i.stat || "(empty)"}

## Diff${i.truncated ? " (truncated; read the files for the rest)" : ""}
\`\`\`diff
${i.diff || "(no changes)"}
\`\`\`

## Your task
Review the change for correctness bugs, security problems, broken edge cases, missing handling the acceptance criteria require, and regressions. Open the surrounding code when the diff alone is not enough. Do NOT report style or taste. Classify each issue:
- "severe": the change is wrong or dangerous (bug that breaks the feature, data loss, security hole, acceptance criterion not met); it must be fixed before the card can be accepted.
- "major": a real problem that should be fixed but does not break the main flow.
- "minor": small improvement.
Reply with ONE JSON object (in a \`\`\`json fence, nothing after it):
{"verdict": "pass|issues|severe", "summary": "one or two sentences", "issues": [{"severity": "severe|major|minor", "file": "path/relative/to/worktree", "line": 12, "text": "what is wrong and how to fix it"}]}
Use an empty issues array and verdict "pass" when you find nothing worth reporting. Do not modify anything; do not write files.`;
}

export function issueLocation(issue: ReviewIssue): string {
  return issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "";
}

/** The reviewer's conclusion as one chat message for the card (Chinese; issue lines are the reviewer's own text). */
export function reviewChatText(
  verdict: "pass" | "issues" | "severe",
  summary: string,
  issues: readonly string[],
  failure?: string,
): string {
  if (failure) return `复核没有完成：${failure}`;
  const head =
    verdict === "pass"
      ? "复核通过"
      : verdict === "severe"
        ? `复核发现严重问题（共 ${issues.length} 条）`
        : `复核发现 ${issues.length} 条问题`;
  const lines = issues.slice(0, 8).map((i) => `- ${i}`);
  if (issues.length > lines.length) lines.push(`- 另有 ${issues.length - lines.length} 条，见验证标签`);
  return [summary ? `${head}：${summary}` : head, ...lines].join("\n");
}
