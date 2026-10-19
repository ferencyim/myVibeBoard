// Tells vibe-board's lifecycle that the next turn on `agentId` is ours (compaction), not the user
// continuing the chat, so a verifying card is not pulled back to in_progress. Paseo's turn_started
// hook carries no message metadata, hence this marker file in `$VIBE_HOME/system-turns/`.
// Mirrors plugins/vibe-board/server/lifecycle/system-turn.ts (plugins cannot share modules).

import { mkdirSync, writeFileSync } from "node:fs";
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
