import { z } from "zod";
import type { Judgement } from "../vibe/contract";

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

export function issueLocation(issue: ReviewIssue): string {
  return issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "";
}
