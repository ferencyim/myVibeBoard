// Pure helpers of the draft discussion tab (WP-33). The discussion is a set of `note` events on
// the card written by this UI (owner) and by vibe-master's planning session (see
// vibe-master/server/planning/thread.ts); plugins never call each other, the card is the channel.

import type { AgentSession, CardEvent } from "../../shared/vibe/contract";

export type DiscussionItem =
  | {
      id: string;
      kind: "user" | "planner";
      text: string;
      at: string;
      error?: boolean;
      ready?: boolean;
      planVersion?: number;
      answered: boolean;
    }
  | { id: string; kind: "research" | "handoff"; text: string; at: string; path?: string | null };

interface Body {
  kind?: string;
  role?: string;
  text?: string;
  answers?: unknown;
  error?: boolean;
  ready?: boolean;
  planVersion?: number;
  path?: string | null;
}

const bodyOf = (e: CardEvent): Body =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Body) : {};

export const userMessageBody = (text: string) => ({ kind: "discussion", role: "user", text });
export const HANDOFF_REQUEST_BODY = { kind: "handoff_request" } as const;

const answersOf = (e: CardEvent): string[] => {
  const a = bodyOf(e).answers;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
};

/** The discussion in order, with each owner message marked answered or still waiting. */
export function discussionOf(events: readonly CardEvent[]): DiscussionItem[] {
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type === "note" && e.authorKind === "agent") for (const id of answersOf(e)) answered.add(id);
  }
  const items: DiscussionItem[] = [];
  for (const e of events) {
    if (e.type !== "note") continue;
    const b = bodyOf(e);
    if (b.kind === "discussion" && typeof b.text === "string") {
      const planner = e.authorKind === "agent" || b.role === "planner";
      items.push(
        planner
          ? {
              id: e.id,
              kind: "planner",
              text: b.text,
              at: e.createdAt,
              error: b.error,
              ready: b.ready,
              planVersion: b.planVersion,
              answered: true,
            }
          : { id: e.id, kind: "user", text: b.text, at: e.createdAt, answered: answered.has(e.id) },
      );
    } else if (b.kind === "discussion_research" && typeof b.text === "string") {
      items.push({ id: e.id, kind: "research", text: b.text, at: e.createdAt });
    } else if (b.kind === "handoff" && typeof b.text === "string") {
      items.push({ id: e.id, kind: "handoff", text: b.text, at: e.createdAt, path: b.path });
    }
  }
  return items;
}

/** The planner has an unanswered owner message to work on. */
export const waitingForPlanner = (items: readonly DiscussionItem[]) =>
  items.some((i) => i.kind === "user" && !i.answered);

/** The newest planner message says the plan can be executed and nothing was said since. */
export function planReady(items: readonly DiscussionItem[]): boolean {
  const last = [...items].reverse().find((i) => i.kind === "planner" || i.kind === "user");
  return !!last && last.kind === "planner" && !!last.ready && !last.error;
}

/** The hand-off event that answers a given hand-off request, if the planner wrote it. */
export function handoffAnswering(
  events: readonly CardEvent[],
  requestId: string,
): CardEvent | undefined {
  return events.find(
    (e) =>
      e.type === "note" &&
      e.authorKind === "agent" &&
      bodyOf(e).kind === "handoff" &&
      answersOf(e).includes(requestId),
  );
}

export function plannerSessionOf(sessions: readonly AgentSession[]): AgentSession | undefined {
  return sessions.filter((s) => s.role === "planner").at(-1);
}

export function sessionStatusLabel(session: AgentSession | undefined): string {
  if (!session) return "尚未开始";
  switch (session.state) {
    case "starting":
    case "working":
      return "规划中…";
    case "idle":
    case "waiting":
      return "等待你的回复";
    case "error":
      return "出错（再发一条消息重试）";
    default:
      return "已归档";
  }
}
