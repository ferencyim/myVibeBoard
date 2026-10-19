// Board state machine (pure functions). See docs/vibe/ARCHITECTURE.md section 3.5.
//
//   draft <-> todo                       user (the phone may do this offline)
//   todo -> in_progress                  dispatcher (worktree + session created)
//   in_progress -> verifying             lifecycle (agent round completed, no open question)
//   verifying -> in_progress             verifier (a check failed) | user (reject)
//                                        | lifecycle (user continued the session)
//   verifying -> done                    user only ("pass")
//
// The master agent never moves cards; it may only suggest. The phone (offline) may only move
// cards between draft and todo; every other column is decided by the daemon.

import type { CardColumn, CardOrigin, SessionState } from "./enums";
import { CARD_COLUMNS } from "./enums";

export const MOVE_ACTORS = [
  "user",
  "phone",
  "dispatcher",
  "lifecycle",
  "verifier",
  "master",
] as const;
export type MoveActor = (typeof MOVE_ACTORS)[number];

export interface TransitionRule {
  from: CardColumn;
  to: CardColumn;
  actors: readonly MoveActor[];
}

export const CARD_TRANSITIONS: readonly TransitionRule[] = [
  { from: "draft", to: "todo", actors: ["user", "phone"] },
  { from: "todo", to: "draft", actors: ["user", "phone"] },
  { from: "todo", to: "in_progress", actors: ["dispatcher"] },
  { from: "in_progress", to: "verifying", actors: ["lifecycle"] },
  { from: "verifying", to: "in_progress", actors: ["verifier", "user", "lifecycle"] },
  { from: "verifying", to: "done", actors: ["user"] },
];

export type MoveVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "same_column" | "illegal_transition" | "actor_not_allowed";
      message: string;
    };

export class StateMachineError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "StateMachineError";
    this.reason = reason;
  }
}

export function checkTransition(from: CardColumn, to: CardColumn, actor: MoveActor): MoveVerdict {
  if (from === to) {
    return { ok: false, reason: "same_column", message: `Card is already in "${from}"` };
  }
  const rule = CARD_TRANSITIONS.find((r) => r.from === from && r.to === to);
  if (!rule) {
    return {
      ok: false,
      reason: "illegal_transition",
      message: `Cards cannot move from "${from}" to "${to}"`,
    };
  }
  if (!rule.actors.includes(actor)) {
    return {
      ok: false,
      reason: "actor_not_allowed",
      message: `"${actor}" may not move a card from "${from}" to "${to}" (allowed: ${rule.actors.join(", ")})`,
    };
  }
  return { ok: true };
}

export function assertTransition(from: CardColumn, to: CardColumn, actor: MoveActor): void {
  const verdict = checkTransition(from, to, actor);
  if (!verdict.ok) throw new StateMachineError(verdict.reason, verdict.message);
}

/** Columns `actor` may move a card to from `from` (used by the "Move to" menu). */
export function allowedTargets(from: CardColumn, actor: MoveActor): CardColumn[] {
  return CARD_COLUMNS.filter((to) => checkTransition(from, to, actor).ok);
}

/** Columns a new card may be created in. Maintenance "fix" cards go straight to in_progress. */
export function canCreateIn(column: CardColumn, origin: CardOrigin, actor: MoveActor): boolean {
  if (column === "draft") return true;
  if (column === "todo") return actor === "user" || actor === "phone";
  if (column === "in_progress") return origin === "maintenance" && actor === "dispatcher";
  return false;
}

// --- agent session states ---------------------------------------------------------------

export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  starting: ["working", "idle", "waiting", "ended", "error"],
  working: ["waiting", "idle", "ended", "error"],
  waiting: ["working", "idle", "ended", "error"],
  idle: ["working", "waiting", "ended", "error"],
  error: ["working", "ended"],
  ended: [],
};

export function canSessionTransition(from: SessionState, to: SessionState): boolean {
  return from === to || SESSION_TRANSITIONS[from].includes(to);
}

export function assertSessionTransition(from: SessionState, to: SessionState): void {
  if (!canSessionTransition(from, to)) {
    throw new StateMachineError(
      "illegal_session_transition",
      `Session cannot go from "${from}" to "${to}"`,
    );
  }
}
