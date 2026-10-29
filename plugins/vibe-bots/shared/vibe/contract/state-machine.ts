// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { SessionState } from "./enums";

export class StateMachineError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "StateMachineError";
    this.reason = reason;
  }
}

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
