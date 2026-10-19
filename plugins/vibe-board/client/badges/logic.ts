// Card badge: the current state of the card's live session (agent_session.state + pending_question).

import type { AgentSession } from "../../shared/vibe/contract";
import { parseQuestion } from "../sessions/logic";

export type BadgeTone = "danger" | "warning" | "active" | "muted";

export interface CardBadge {
  label: string;
  tone: BadgeTone;
  /** One line under/next to the label (the open question). */
  detail?: string;
}

const LIVE_PRIORITY: Record<string, number> = { waiting: 0, error: 1, working: 2, starting: 2, idle: 3 };

/** The session that decides a card's badge: waiting > error > working > idle; ended gives none. */
export function badgeSession(sessions: readonly AgentSession[]): AgentSession | null {
  let best: AgentSession | null = null;
  for (const s of sessions) {
    if (s.state === "ended" || s.role === "master") continue;
    if (!best || (LIVE_PRIORITY[s.state] ?? 9) < (LIVE_PRIORITY[best.state] ?? 9)) best = s;
  }
  return best;
}

export function badgeOf(session: AgentSession | null): CardBadge | null {
  if (!session) return null;
  switch (session.state) {
    case "waiting": {
      const q = parseQuestion(session.pendingQuestion);
      const detail = q?.questions[0] || q?.title || q?.description || q?.name || undefined;
      return {
        label: q?.kind === "question" ? "等待回答" : "等待审批",
        tone: "danger",
        ...(detail ? { detail } : {}),
      };
    }
    case "error":
      return { label: "出错", tone: "danger", detail: session.errorMessage ?? undefined };
    case "working":
    case "starting":
      return { label: "运行中", tone: "active" };
    case "idle":
      return { label: "已停下", tone: "muted" };
    default:
      return null;
  }
}

/** cardId -> badge for a whole session list. */
export function badgesByCard(sessions: readonly AgentSession[]): Map<string, CardBadge> {
  const byCard = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    if (!s.cardId) continue;
    byCard.set(s.cardId, [...(byCard.get(s.cardId) ?? []), s]);
  }
  const out = new Map<string, CardBadge>();
  for (const [cardId, list] of byCard) {
    const badge = badgeOf(badgeSession(list));
    if (badge) out.set(cardId, badge);
  }
  return out;
}
