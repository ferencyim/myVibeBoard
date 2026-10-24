// Tells vibe-board's lifecycle that the next turn on `agentId` is ours (compaction), not the user
// continuing the chat. Paseo's turn_started
// hook carries no message metadata, hence this marker file in `$VIBE_HOME/system-turns/`.
// Mirrors plugins/vibe-board/server/lifecycle/system-turn.ts (plugins cannot share modules).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveVibeHome } from "../vibe/db";

const WINDOW_MS = 60_000;

export function expectSystemTurn(agentId: string, home: string = resolveVibeHome()) {
  const dir = join(home, "system-turns");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agentId.replace(/[^\w.-]/g, "_")}.json`),
    JSON.stringify({ expiresAt: Date.now() + WINDOW_MS }),
  );
}

/** True while a still-valid marker exists. Does not consume it (vibe-board's lifecycle does). */
export function peekSystemTurn(agentId: string, home: string = resolveVibeHome()): boolean {
  try {
    const file = join(home, "system-turns", `${agentId.replace(/[^\w.-]/g, "_")}.json`);
    const { expiresAt } = JSON.parse(readFileSync(file, "utf8")) as { expiresAt?: number };
    return (expiresAt ?? 0) >= Date.now();
  } catch {
    return false;
  }
}
