// The discussion lives on the card as `chat` events (the card group chat), so every client
// (desktop, phone, offline sync) reads and writes it the same way and plugins never call each other:
//
//   chat(user)                              an owner message
//   chat(master, answers: [...])            the planner's reply (also assessment verdicts)
//   chat(scout, kind summary)               findings of a read-only scout sub-agent
//   note { kind: "handoff_request" }        the owner wants to move to todo
//   note { kind: "handoff", text, path }    the hand-off summary (planner)
//
// An owner message counts as handled when any chat event lists its id in `answers`, which makes
// "what is still unanswered" a pure function of the card's events (survives restarts and late
// offline arrivals). Which messages belong to the planner depends on the card column and on
// whether an executing agent is online (the board's chat router forwards to it), see `routedToPlanner`.

import type { CardColumn, CardEvent } from "../vibe/contract";

export const HANDOFF_REQUEST = "handoff_request";
export const HANDOFF = "handoff";
export const PLANNER_AUTHOR = "planner";

interface Body {
  kind?: string;
  text?: string;
  answers?: unknown;
  fallback?: unknown;
  planVersion?: number;
}
const bodyOf = (e: CardEvent): Body =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Body) : {};

const isNote = (e: CardEvent) => e.type === "note";
const isChat = (e: CardEvent) => e.type === "chat";
const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

export interface ThreadMessage {
  id: string;
  role: "user" | "planner";
  text: string;
  at: string;
}

/** Owner messages and the master's replies in order (scouts, system lines and executor chat excluded). */
export function messagesOf(events: readonly CardEvent[]): ThreadMessage[] {
  return events
    .filter(
      (e) =>
        isChat(e) &&
        (e.authorKind === "user" || e.authorKind === "master") &&
        typeof bodyOf(e).text === "string",
    )
    .map((e) => ({
      id: e.id,
      role: e.authorKind === "master" ? ("planner" as const) : ("user" as const),
      text: bodyOf(e).text as string,
      at: e.createdAt,
    }));
}

/** What decides who handles a user message. */
export interface RoutingContext {
  column: CardColumn;
  /** The card has a worker session in starting/working/waiting/idle. */
  executorOnline: boolean;
}

/**
 * Does the planner (master) handle a user message of this card? draft/todo: always. in_progress /
 * verifying: only without an online executor, or when the router gave up on forwarding it
 * (`fallback`). done: nobody.
 */
export function routedToPlanner(ctx: RoutingContext, fallback: boolean): boolean {
  if (ctx.column === "draft" || ctx.column === "todo") return true;
  if (ctx.column === "in_progress" || ctx.column === "verifying") return !ctx.executorOnline || fallback;
  return false;
}

export interface ThreadState {
  /** Owner messages for the planner that nobody answered yet, oldest first. */
  pending: ThreadMessage[];
  /** Hand-off requests nobody answered yet. */
  handoffRequests: CardEvent[];
  /** The newest hand-off summary event, if any. */
  handoff: CardEvent | undefined;
  /** An owner message arrived after the newest hand-off (the discussion went on). */
  discussedAfterHandoff: boolean;
  hasDiscussion: boolean;
}

export function threadState(events: readonly CardEvent[], ctx: RoutingContext): ThreadState {
  const answered = new Set<string>();
  const fallback = new Set<string>();
  for (const e of events) {
    if (isChat(e)) {
      for (const id of idsOf(bodyOf(e).answers)) answered.add(id);
      for (const id of idsOf(bodyOf(e).fallback)) fallback.add(id);
    } else if (isNote(e) && e.authorKind === "agent") {
      for (const id of idsOf(bodyOf(e).answers)) answered.add(id);
    }
  }
  const messages = messagesOf(events);
  const pending = messages.filter(
    (m) => m.role === "user" && !answered.has(m.id) && routedToPlanner(ctx, fallback.has(m.id)),
  );
  const handoffRequests = events.filter(
    (e) => isNote(e) && e.authorKind !== "agent" && bodyOf(e).kind === HANDOFF_REQUEST && !answered.has(e.id),
  );
  const handoff = events.filter((e) => isNote(e) && bodyOf(e).kind === HANDOFF).at(-1);
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
