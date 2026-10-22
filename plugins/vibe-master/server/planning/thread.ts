// The plan conversation lives on the card as `chat` events of the plan thread (WP-105), so every
// client (desktop, phone, offline sync) reads and writes it the same way and plugins never call
// each other:
//
//   chat(user, thread plan)                 an owner message; action "make_plan" = the 制定方案 button
//   chat(master/planner, answers: [...])    the planning model's reply
//   chat(scout, thread plan)                findings of a read-only scout
//
// An owner message counts as handled when any chat event lists its id in `answers`, which makes
// "what is still unanswered" a pure function of the card's events (survives restarts and late
// offline arrivals). Messages of the execution thread belong to the board's chat router.

import { chatThreadOf, type CardEvent } from "../vibe/contract";

export const PLANNER_AUTHOR = "planner";

interface Body {
  text?: string;
  answers?: unknown;
  action?: string;
}
const bodyOf = (e: CardEvent): Body =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as Body) : {};

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

export interface ThreadMessage {
  id: string;
  role: "user" | "planner";
  text: string;
  at: string;
  /** The owner pressed 制定方案 (plan from scratch, scouting first). */
  makePlan?: boolean;
}

const isPlanChat = (e: CardEvent) => e.type === "chat" && chatThreadOf(e) === "plan";

/** Owner messages and the planner's replies of the plan thread, in order (scouts and system lines excluded). */
export function messagesOf(events: readonly CardEvent[]): ThreadMessage[] {
  return events
    .filter(
      (e) =>
        isPlanChat(e) &&
        (e.authorKind === "user" || e.authorKind === "master") &&
        typeof bodyOf(e).text === "string",
    )
    .map((e) => ({
      id: e.id,
      role: e.authorKind === "master" ? ("planner" as const) : ("user" as const),
      text: bodyOf(e).text as string,
      at: e.createdAt,
      ...(bodyOf(e).action === "make_plan" ? { makePlan: true } : {}),
    }));
}

export interface ThreadState {
  /** Owner messages of the plan thread nobody answered yet, oldest first. */
  pending: ThreadMessage[];
  hasDiscussion: boolean;
}

export function threadState(events: readonly CardEvent[]): ThreadState {
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type === "chat") for (const id of idsOf(bodyOf(e).answers)) answered.add(id);
  }
  const messages = messagesOf(events);
  return {
    pending: messages.filter((m) => m.role === "user" && !answered.has(m.id)),
    hasDiscussion: messages.length > 0,
  };
}

/** Plain transcript for prompts (oldest first, clipped). */
export function transcript(messages: readonly ThreadMessage[], maxChars = 12_000): string {
  const lines = messages.map((m) => `${m.role === "user" ? "负责人" : "规划"}：${m.text.trim()}`);
  let out = lines.join("\n\n");
  if (out.length > maxChars) out = `…（更早的消息已省略）\n${out.slice(out.length - maxChars)}`;
  return out;
}
