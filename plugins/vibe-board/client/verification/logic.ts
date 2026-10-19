// Pure helpers of the verification-result block: conclusion, attention items, evidence grouping,
// provenance lines. No React / host imports, so they are unit-tested directly.

import type { EvidenceFile, Judgement, VerificationItem } from "../../shared/vibe/contract";

export type Conclusion = Judgement | "running" | "none";

export const JUDGEMENT_LABELS: Record<Judgement, string> = { pass: "通过", doubt: "存疑", fail: "失败" };

export const HEADLINES: Record<Conclusion, string> = {
  pass: "全部通过",
  doubt: "有存疑",
  fail: "有失败",
  running: "验证进行中",
  none: "尚无验证结果",
};

interface DetailLike {
  verification: { conclusion: Judgement | null; finishedAt: string | null };
  items: readonly Pick<VerificationItem, "judgement">[];
}

/** fail beats doubt beats pass; an unjudged item counts as doubt (same rule as vibe-verify). */
export function aggregate(judgements: ReadonlyArray<Judgement | null>): Judgement {
  if (judgements.includes("fail")) return "fail";
  if (judgements.length === 0 || judgements.some((j) => j === null || j === "doubt")) return "doubt";
  return "pass";
}

/** The headline conclusion: the recorded one, "running" while unfinished, "none" without a run. */
export function conclusionOf(detail: DetailLike | null | undefined): Conclusion {
  if (!detail) return "none";
  if (detail.verification.conclusion) return detail.verification.conclusion;
  if (!detail.verification.finishedAt) return "running";
  return aggregate(detail.items.map((i) => i.judgement));
}

/** Items the user has to look at: failed, doubtful or never judged. */
export function needsAttention(item: Pick<VerificationItem, "judgement">, finished = true): boolean {
  return item.judgement === "fail" || item.judgement === "doubt" || (finished && item.judgement === null);
}

export function judgementOf(item: Pick<VerificationItem, "judgement">, finished = true): Judgement | "pending" {
  return item.judgement ?? (finished ? "doubt" : "pending");
}

export function counts(items: readonly Pick<VerificationItem, "judgement">[]) {
  const out = { pass: 0, doubt: 0, fail: 0, pending: 0 };
  for (const item of items) out[item.judgement ?? "pending"]++;
  return out;
}

export function countsLine(items: readonly Pick<VerificationItem, "judgement">[]): string {
  const c = counts(items);
  const parts = [`${items.length} 项检查`];
  if (c.pass) parts.push(`${c.pass} 通过`);
  if (c.doubt) parts.push(`${c.doubt} 存疑`);
  if (c.fail) parts.push(`${c.fail} 失败`);
  if (c.pending) parts.push(`${c.pending} 待判`);
  return parts.join(" · ");
}

/** Evidence of one item: the ids it lists plus files tagged with its id, in capture order, unique. */
export function evidenceForItem(
  item: Pick<VerificationItem, "id" | "evidenceIds">,
  evidence: readonly EvidenceFile[],
): EvidenceFile[] {
  return evidence.filter((e) => item.evidenceIds.includes(e.id) || e.itemId === item.id);
}

/** Evidence that belongs to no item (run-wide: logs, reports, full-flow recordings). */
export function unattachedEvidence(
  items: readonly Pick<VerificationItem, "id" | "evidenceIds">[],
  evidence: readonly EvidenceFile[],
): EvidenceFile[] {
  const attached = new Set(items.flatMap((i) => evidenceForItem(i, evidence).map((e) => e.id)));
  return evidence.filter((e) => !attached.has(e.id));
}

export type PreviewKind = "image" | "gif" | "video" | "text" | "other";

const ext = (p: string) => p.slice(p.lastIndexOf(".") + 1).toLowerCase();

export function previewKind(e: Pick<EvidenceFile, "kind" | "path">): PreviewKind {
  const x = ext(e.path);
  if (e.kind === "gif" || x === "gif") return "gif";
  if (e.kind === "video" || x === "mp4" || x === "webm" || x === "mov") return "video";
  if (["png", "jpg", "jpeg", "webp"].includes(x)) return "image";
  if (e.kind === "log" || e.kind === "report" || ["txt", "log", "md", "json"].includes(x)) return "text";
  return "other";
}

export const fileName = (p: string) => p.split(/[\/]/).pop() || p;

export const shortHash = (hash: string) => hash.slice(0, 7);

/** "2026-10-19 14:03" (UTC, same style as the timeline). */
export const formatTime = (iso: string) => iso.replace("T", " ").slice(0, 16);

export const EVIDENCE_KIND_LABELS: Record<EvidenceFile["kind"], string> = {
  screenshot: "截图",
  gif: "动图",
  video: "录屏",
  log: "日志",
  report: "报告",
  photo: "照片",
};

/** Provenance line under every piece of evidence: when, which commit, and whether simulated. */
export function provenance(e: Pick<EvidenceFile, "capturedAt" | "commitHash" | "simulated">): string {
  return [
    formatTime(e.capturedAt),
    e.commitHash ? `commit ${shortHash(e.commitHash)}` : "",
    e.simulated ? "仿真取证" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One-line warning when any evidence was produced by a simulator or a degraded fallback. */
export function simulatedNotice(evidence: readonly Pick<EvidenceFile, "simulated">[]): string | null {
  const n = evidence.filter((e) => e.simulated).length;
  if (n === 0) return null;
  return n === evidence.length
    ? "全部证据为仿真取证（模拟器或降级采集），不是真机/真实环境结果。"
    : `${n} 份证据为仿真取证（模拟器或降级采集），不是真机/真实环境结果。`;
}

export const dataUri = (mimeType: string, base64: string) => `data:${mimeType};base64,${base64}`;

/** Decode a base64 text file for the excerpt view; cut at `max` characters. */
export function textExcerpt(base64: string, max = 4000): { text: string; truncated: boolean } {
  let text: string;
  try {
    const bin = atob(base64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    return { text: "（无法解码）", truncated: false };
  }
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** The user may decide only while the card sits in verifying. */
export const canDecide = (column: string) => column === "verifying";

export type RejectCheck = { ok: true; comment: string } | { ok: false; message: string };

export function checkRejection(input: string): RejectCheck {
  const comment = input.trim();
  return comment ? { ok: true, comment } : { ok: false, message: "请写一句驳回意见" };
}
