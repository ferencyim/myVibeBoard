// Model code review of a card (WP-80). A second, read-only agent on the card's reviewer preset
// reads the diff and returns structured issues. The pipeline turns them into verification items
// (kind=review): severe -> fail (card is sent back), major/minor -> doubt, none -> pass.

import { z } from "zod";
import type { CardView, Judgement, PlanVersion } from "../vibe/contract";
import { defaultPrompts, type PromptResolver } from "../prompts";

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

/** Default issue severity -> judgement (settings can change it, see tuning.ts). */
export const DEFAULT_SEVERITY_MAP: Record<IssueSeverity, Judgement> = {
  severe: "fail",
  major: "doubt",
  minor: "doubt",
};

/** A "fail" only counts while the return budget lasts (then it is only doubtful). */
export function issueJudgement(
  severity: IssueSeverity,
  allowReturn: boolean,
  map: Record<IssueSeverity, Judgement> = DEFAULT_SEVERITY_MAP,
): Judgement {
  const judgement = map[severity];
  return judgement === "fail" && !allowReturn ? "doubt" : judgement;
}

export interface ReviewPromptInput {
  card: CardView;
  plan?: PlanVersion;
  worktree: string;
  commitHash: string;
  baseCommit?: string;
  stat: string;
  diff: string;
  truncated: boolean;
  prompts?: PromptResolver;
}

function planSection(plan: NonNullable<PlanVersion["snapshot"]>): string {
  const checks = plan.checks.map((c, n) => `${n + 1}. ${c.text}`).join("\n");
  return `\n## 最新计划\n${plan.description}\n${checks}${plan.notes ? `\n备注：${plan.notes}` : ""}\n`;
}

export function buildReviewPrompt(i: ReviewPromptInput): string {
  const plan = i.plan?.snapshot;
  return (i.prompts ?? defaultPrompts).resolve("verify.review", {
    projectId: i.card.projectId,
    vars: {
      "card.key": i.card.key,
      "card.title": i.card.title,
      worktree: i.worktree,
      commitHash: i.commitHash,
      baseNote: i.baseCommit ? `  （与 ${i.baseCommit} 比较的 diff）` : "  （未找到基线提交：只有未提交的改动）",
      description: i.card.description || "（无）",
      acceptance: i.card.acceptance || "（无）",
      plan: plan ? planSection(plan) : "",
      stat: i.stat || "（空）",
      truncatedNote: i.truncated ? "（已截断；其余部分请直接读文件）" : "",
      diff: i.diff || "（无改动）",
    },
  });
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
