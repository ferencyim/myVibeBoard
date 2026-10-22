// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Card detail tabs (WP-105): which conversation a chat message belongs to, which tab a card event
// makes "new", and the unread markers. Pure, shared by the daemon (stamping), the board UI and the
// App's offline replica.

import type { ChatThread, UnreadTab } from "./enums";
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
 * The conversation of a `chat` event. Rows written before WP-105 carry no `thread`: executor and
 * reviewer messages and the dispatch / forwarding system lines are execution, the rest is planning.
 */
export function chatThreadOf(e: Pick<CardEvent, "authorKind" | "author" | "body">): ChatThread {
  const thread = bodyOf(e).thread;
  if (thread === "plan" || thread === "exec") return thread;
  if (e.authorKind === "executor" || e.authorKind === "reviewer") return "exec";
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
      if (e.authorKind === "reviewer") return ["exec", "verify"];
      return [chatThreadOf(e)];
    case "proposal":
      return ["plan"];
    case "note":
      return kind === "plan_updated" ? ["plan"] : [];
    case "status":
      return kind === "verification" ? ["verify"] : [];
    case "reject":
      return ["verify"];
    default:
      return [];
  }
}

export const ACTIVITY_COLUMN: Record<UnreadTab, "plan_activity_at" | "exec_activity_at" | "verify_activity_at"> = {
  plan: "plan_activity_at",
  exec: "exec_activity_at",
  verify: "verify_activity_at",
};

type UnreadFields = Pick<
  CardView,
  "planActivityAt" | "execActivityAt" | "verifyActivityAt" | "planSeenAt" | "execSeenAt" | "verifySeenAt"
>;

/** Newest content of a tab and what the owner has seen of it. */
export function tabMarks(card: UnreadFields, tab: UnreadTab): { activity: string | null; seen: string | null } {
  switch (tab) {
    case "plan":
      return { activity: card.planActivityAt, seen: card.planSeenAt };
    case "exec":
      return { activity: card.execActivityAt, seen: card.execSeenAt };
    case "verify":
      return { activity: card.verifyActivityAt, seen: card.verifySeenAt };
  }
}

export function isTabUnread(card: UnreadFields, tab: UnreadTab): boolean {
  const { activity, seen } = tabMarks(card, tab);
  return !!activity && (!seen || activity > seen);
}

export function unreadTabsOf(card: UnreadFields): UnreadTab[] {
  return (["plan", "exec", "verify"] as const).filter((t) => isTabUnread(card, t));
}

/**
 * The card patch that marks a tab read: the seen position becomes the tab's newest content time
 * (never the local clock, so a phone whose clock lags still clears the marker). Null = already read.
 */
export function markReadPatch(
  card: UnreadFields,
  tab: UnreadTab,
): Partial<Pick<CardView, "planSeenAt" | "execSeenAt" | "verifySeenAt">> | null {
  if (!isTabUnread(card, tab)) return null;
  const { activity } = tabMarks(card, tab);
  switch (tab) {
    case "plan":
      return { planSeenAt: activity };
    case "exec":
      return { execSeenAt: activity };
    case "verify":
      return { verifySeenAt: activity };
  }
}
