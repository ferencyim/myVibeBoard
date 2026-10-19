// The discussion lives on the card as `note` events, so every client (desktop, phone, offline
// sync) reads and writes it the same way and plugins never call each other:
//
//   { kind: "discussion", role: "user" | "planner", text, ... }   one message
//   { kind: "discussion_research", text, items }                  sub-agent findings (planner)
//   { kind: "handoff_request" }                                   the owner wants to move to todo
//   { kind: "handoff", text, path }                               the hand-off summary (planner)
//
// Planner events list the owner events they answered in `answers`, which makes "what is still
// unanswered" a pure function of the card's events (survives restarts and late offline arrivals).

import type { CardEvent } from "../vibe/contract";

export const DISCUSSION = "discussion";
export const DISCUSSION_RESEARCH = "discussion_research";
export const HANDOFF_REQUEST = "handoff_request";
export const HANDOFF = "handoff";
export const PLANNER_AUTHOR = "planner";

interface Body {
  kind?: string;
  role?: string;
  text?: string;
  answers?: unknown;
  planVersion?: number;
}
const bodyOf = (e: CardEvent): Body =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Body) : {};

const isNote = (e: CardEvent) => e.type === "note";
const answersOf = (e: CardEvent): string[] => {
  const a = bodyOf(e).answers;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
};

export interface ThreadMessage {
  id: string;
  role: "user" | "planner";
  text: string;
  at: string;
}

/** All discussion messages in order (research and hand-off entries excluded). */
export function messagesOf(events: readonly CardEvent[]): ThreadMessage[] {
  return events
    .filter((e) => isNote(e) && bodyOf(e).kind === DISCUSSION && typeof bodyOf(e).text === "string")
    .map((e) => ({
      id: e.id,
      role: bodyOf(e).role === "planner" || e.authorKind === "agent" ? ("planner" as const) : ("user" as const),
      text: bodyOf(e).text as string,
      at: e.createdAt,
    }));
}

export interface ThreadState {
  /** Owner messages nobody answered yet, oldest first. */
  pending: ThreadMessage[];
  /** Hand-off requests nobody answered yet. */
  handoffRequests: CardEvent[];
  /** The newest hand-off summary event, if any. */
  handoff: CardEvent | undefined;
  /** An owner message arrived after the newest hand-off (the discussion went on). */
  discussedAfterHandoff: boolean;
  hasDiscussion: boolean;
}

export function threadState(events: readonly CardEvent[]): ThreadState {
  const answered = new Set<string>();
  for (const e of events) {
    if (isNote(e) && e.authorKind === "agent") for (const id of answersOf(e)) answered.add(id);
  }
  const owner = events.filter((e) => isNote(e) && e.authorKind !== "agent");
  const messages = messagesOf(events);
  const pending = messages.filter((m) => m.role === "user" && !answered.has(m.id));
  const handoffRequests = owner.filter(
    (e) => bodyOf(e).kind === HANDOFF_REQUEST && !answered.has(e.id),
  );
  const handoffs = events.filter((e) => isNote(e) && bodyOf(e).kind === HANDOFF);
  const handoff = handoffs.at(-1);
  const lastUserAt = messages.filter((m) => m.role === "user").at(-1)?.at;
  return {
    pending,
    handoffRequests,
    handoff,
    discussedAfterHandoff: !!handoff && !!lastUserAt && lastUserAt > handoff.createdAt,
    hasDiscussion: messages.length > 0,
  };
}

/** Plain transcript for prompts (oldest first, clipped). */
export function transcript(messages: readonly ThreadMessage[], maxChars = 12_000): string {
  const lines = messages.map((m) => `${m.role === "user" ? "OWNER" : "PLANNER"}: ${m.text.trim()}`);
  let out = lines.join("\n\n");
  if (out.length > maxChars) out = `…(earlier messages omitted)\n${out.slice(out.length - maxChars)}`;
  return out;
}
