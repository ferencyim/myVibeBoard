// Card detail tabs (WP-105): which conversation a chat message belongs to, which tab a card event
// makes "new", and the unread markers. Pure, shared by the daemon (stamping), the board UI and the
// App's offline replica.

import { UNREAD_TABS, type ChatThread, type UnreadTab } from "./enums";
import type { CardEvent, CardView } from "./model";

interface BodyLike {
  kind?: unknown;
  thread?: unknown;
}

const bodyOf = (e: Pick<CardEvent, "body">): BodyLike =>
  e.body && typeof e.body === "object" && !Array.isArray(e.body) ? (e.body as BodyLike) : {};

/** System authors of execution-side chat lines on rows written before WP-105. */
const LEGACY_EXEC_AUTHORS = new Set(["dispatch", "chat-router", "failover", "lifecycle", "watchdog"]);

/**
 * The conversation of a `chat` event. An explicit plan / review thread wins (the plan reviewer of
 * WP-108 speaks in the plan thread). Any other reviewer message is a review conclusion: rows written
 * before WP-108 say `thread: "exec"`. Rows written before WP-105 carry no `thread`: executor
 * messages and the dispatch / forwarding system lines are execution, the rest is planning.
 */
export function chatThreadOf(e: Pick<CardEvent, "authorKind" | "author" | "body">): ChatThread {
  const thread = bodyOf(e).thread;
  if (thread === "plan" || thread === "review") return thread;
  if (e.authorKind === "reviewer") return "review";
  if (thread === "exec") return thread;
  if (e.authorKind === "executor") return "exec";
  if (e.authorKind === "system" && LEGACY_EXEC_AUTHORS.has(e.author)) return "exec";
  return "plan";
}

/** Tabs that a new card event gives new content (the owner's own messages never do). */
export function activityTabsOf(
  e: Pick<CardEvent, "type" | "authorKind" | "author" | "body">,
): UnreadTab[] {
  if (e.authorKind === "user") return [];
  const kind = bodyOf(e).kind;
  switch (e.type) {
    case "chat":
      return [chatThreadOf(e)];
    case "proposal":
      return ["plan"];
    case "note":
      return kind === "plan_updated" ? ["plan"] : [];
    case "status":
      return kind === "verification" ? ["verify"] : [];
    case "reject":
      return (bodyOf(e) as { reviewReturn?: unknown }).reviewReturn === true ? ["review", "verify"] : ["verify"];
    default:
      return [];
  }
}

type ActivityColumn = "plan_activity_at" | "exec_activity_at" | "review_activity_at" | "verify_activity_at";

export const ACTIVITY_COLUMN: Record<UnreadTab, ActivityColumn> = {
  plan: "plan_activity_at",
  exec: "exec_activity_at",
  review: "review_activity_at",
  verify: "verify_activity_at",
};

type UnreadFields = Pick<
  CardView,
  | "planActivityAt"
  | "execActivityAt"
  | "reviewActivityAt"
  | "verifyActivityAt"
  | "planSeenAt"
  | "execSeenAt"
  | "reviewSeenAt"
  | "verifySeenAt"
>;

type SeenField = "planSeenAt" | "execSeenAt" | "reviewSeenAt" | "verifySeenAt";

const FIELDS: Record<UnreadTab, { activity: keyof UnreadFields; seen: SeenField }> = {
  plan: { activity: "planActivityAt", seen: "planSeenAt" },
  exec: { activity: "execActivityAt", seen: "execSeenAt" },
  review: { activity: "reviewActivityAt", seen: "reviewSeenAt" },
  verify: { activity: "verifyActivityAt", seen: "verifySeenAt" },
};

/** Newest content of a tab and what the owner has seen of it. */
export function tabMarks(card: UnreadFields, tab: UnreadTab): { activity: string | null; seen: string | null } {
  return { activity: card[FIELDS[tab].activity], seen: card[FIELDS[tab].seen] };
}

export function isTabUnread(card: UnreadFields, tab: UnreadTab): boolean {
  const { activity, seen } = tabMarks(card, tab);
  return !!activity && (!seen || activity > seen);
}

export function unreadTabsOf(card: UnreadFields): UnreadTab[] {
  return UNREAD_TABS.filter((t) => isTabUnread(card, t));
}

/**
 * The card patch that marks a tab read: the seen position becomes the tab's newest content time
 * (never the local clock, so a phone whose clock lags still clears the marker). Null = already read.
 */
export function markReadPatch(card: UnreadFields, tab: UnreadTab): Partial<Pick<CardView, SeenField>> | null {
  if (!isTabUnread(card, tab)) return null;
  return { [FIELDS[tab].seen]: tabMarks(card, tab).activity };
}
