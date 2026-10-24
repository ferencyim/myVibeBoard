import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { expectSystemTurn } from "../server/compaction/system-turn";
import * as systemTurns from "../server/compaction/system-turn";
import * as schedulerModule from "../server/compaction/scheduler";

it("registers a short-lived marker per agent in $VIBE_HOME/system-turns", () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-turn-"));
  expectSystemTurn("agent/1", home);
  const dir = join(home, "system-turns");
  const files = readdirSync(dir);
  expect(files).toEqual(["agent_1.json"]);
  const { expiresAt } = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  unlinkSync(join(dir, files[0]));
  rmdirSync(dir);
  rmdirSync(home);
});

it("writes notes by the native session path without requiring the old card tool", async () => {
  const { notesPrompt } = await import("../server/compaction");
  const prompt = notesPrompt("/wt/.vibe/sessions/c1.md");
  expect(prompt).toContain("原生任务");
  expect(prompt).not.toContain("vibe_session_note");
  expect(prompt).toContain("/wt/.vibe/sessions/c1.md");
});
