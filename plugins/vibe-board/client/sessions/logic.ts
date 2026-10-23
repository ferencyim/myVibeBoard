// Session overview ordering and wording. Pure (no React), shared by the overview screen and the
// card badges. Mirrors Paseo's deriveAgentStateBucket: needs input > failed > running > done.

import type { AgentSession, CardView } from "../../shared/vibe/contract";

export type SessionBucket = "waiting" | "error" | "running" | "finished";

/** An ended session stays listed this long, so a just-finished round can be picked up for verification. */
export const FINISHED_VISIBLE_MS = 60 * 60 * 1000;

export function sessionBucket(s: Pick<AgentSession, "state">): SessionBucket {
  switch (s.state) {
    case "waiting":
      return "waiting";
    case "error":
      return "error";
    case "starting":
    case "working":
      return "running";
    default:
      return "finished";
  }
}

export const BUCKET_ORDER: Record<SessionBucket, number> = {
  waiting: 0,
  error: 1,
  running: 2,
  finished: 3,
};

export const BUCKET_LABELS: Record<SessionBucket, string> = {
  waiting: "等待你回复",
  error: "出错",
  running: "运行中",
  finished: "刚结束 · 待验证",
};

export interface PendingQuestion {
  requestId: string;
  kind: string;
  name: string;
  title: string;
  description: string;
  /** Question texts of an AskUserQuestion-style request. */
  questions: string[];
}

export function parseQuestion(raw: unknown): PendingQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.requestId !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const input = typeof q.input === "object" && q.input !== null ? (q.input as Record<string, unknown>) : {};
  const questions = Array.isArray(input.questions)
    ? input.questions.map((x) => str((x as { question?: unknown })?.question)).filter(Boolean)
    : [];
  return {
    requestId: q.requestId,
    kind: str(q.kind) || "tool",
    name: str(q.name),
    title: str(q.title),
    description: str(q.description),
    questions,
  };
}

export interface SessionRow {
  session: AgentSession;
  card: CardView | null;
  bucket: SessionBucket;
  /** ms since the session started waiting (0 when it does not). */
  waitedMs: number;
  question: PendingQuestion | null;
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Sessions to show, in order: waiting (longest wait first) > error > running > finished (newest
 * first). Planner/master sessions without a card are listed too. Old ended sessions drop out.
 */
export function buildOverview(
  sessions: readonly AgentSession[],
  cards: readonly CardView[],
  now: number,
): SessionRow[] {
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const rows: SessionRow[] = [];
  for (const session of sessions) {
    if (session.state === "ended" && now - ms(session.endedAt ?? session.lastActivityAt) > FINISHED_VISIBLE_MS) {
      continue;
    }
    const bucket = sessionBucket(session);
    const card = session.cardId ? (cardById.get(session.cardId) ?? null) : null;
    // An idle session of an old card is not "just finished": only verifying cards need a look.
    if (session.state === "idle" && card && card.column !== "verifying" && card.column !== "in_progress") continue;
    rows.push({
      session,
      card,
      bucket,
      waitedMs: bucket === "waiting" ? Math.max(0, now - ms(session.waitingSince ?? session.lastActivityAt)) : 0,
      question: bucket === "waiting" ? parseQuestion(session.pendingQuestion) : null,
    });
  }
  return rows.sort((a, b) => {
    if (a.bucket !== b.bucket) return BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (a.bucket === "waiting") return b.waitedMs - a.waitedMs || (a.session.id < b.session.id ? -1 : 1);
    const byActivity = ms(b.session.lastActivityAt) - ms(a.session.lastActivityAt);
    return byActivity || (a.session.id < b.session.id ? -1 : 1);
  });
}

export function waitingCount(sessions: readonly Pick<AgentSession, "state" | "role">[]): number {
  return sessions.filter((s) => s.state === "waiting").length;
}

/** "5 分钟" style wait text. */
export function formatWait(waitedMs: number): string {
  const minutes = Math.floor(waitedMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `${Math.floor(hours / 24)} 天`;
}

/** "截至 14:05" (local time) for read-only offline data. */
export function asOfLabel(asOf: number | null): string {
  if (asOf === null) return "尚未同步过";
  const d = new Date(asOf);
  const p = (n: number) => String(n).padStart(2, "0");
  return `截至 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const ROLE_LABELS: Record<AgentSession["role"], string> = {
  master: "总 agent",
  planner: "规划",
  worker: "主代理",
  verifier: "验证",
  subagent: "子代理",
  scout: "探路",
  plan_reviewer: "方案复核",
  reviewer: "复核",
};
