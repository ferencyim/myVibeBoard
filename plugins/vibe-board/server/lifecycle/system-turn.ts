// "System turns": turns that a plugin (vibe-context compaction, the master agent, ...) starts on a
// worker session, as opposed to the user continuing the chat. Paseo's turn_started hook carries no
// message metadata, so the sender registers an expectation first as a small marker file in
// `$VIBE_HOME/system-turns/<agentId>.json`; lifecycle consumes it on turn_started (unlink wins the
// race). The same ~25 lines live in vibe-context's compaction code (plugins cannot share modules).

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveVibeHome } from "../vibe/db";

export const SYSTEM_TURN_WINDOW_MS = 60_000;

export const systemTurnDir = (home: string = resolveVibeHome()) => join(home, "system-turns");
const markerPath = (agentId: string, dir: string) =>
  join(dir, `${agentId.replace(/[^\w.-]/g, "_")}.json`);

/** Called by the sender right before it messages `agentId`. */
export function expectSystemTurn(agentId: string, dir = systemTurnDir(), windowMs = SYSTEM_TURN_WINDOW_MS) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath(agentId, dir), JSON.stringify({ expiresAt: Date.now() + windowMs }));
}

/** True (once) when a still-valid marker existed for this agent. */
export function consumeSystemTurn(agentId: string, dir = systemTurnDir()): boolean {
  const file = markerPath(agentId, dir);
  let expiresAt = 0;
  try {
    expiresAt = (JSON.parse(readFileSync(file, "utf8")) as { expiresAt?: number }).expiresAt ?? 0;
    unlinkSync(file);
  } catch {
    return false;
  }
  return expiresAt >= Date.now();
}
