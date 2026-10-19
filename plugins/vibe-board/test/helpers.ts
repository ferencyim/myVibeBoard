import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createBoardService, openBoardRuntime } from "../server/service";

const dirs: string[] = [];

export function tempDir(prefix = "vibe-board-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  // Flat files only: delete one by one, never recursively.
  for (const dir of dirs.splice(0)) {
    try {
      for (const name of readdirSync(dir)) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // sub-directory (bridge bin dir) or still-open handle: leave it
        }
      }
      rmdirSync(dir);
    } catch {
      // best effort
    }
  }
});

export function setupBoard() {
  const runtime = openBoardRuntime({ path: join(tempDir(), "vibe.db") });
  const board = createBoardService(runtime);
  return { runtime, board };
}

export function eventTypes(runtime: ReturnType<typeof setupBoard>["runtime"]): string[] {
  return runtime.db
    .prepare<{ type: string }>("SELECT type FROM vibe_event ORDER BY seq")
    .all()
    .map((r) => r.type);
}
