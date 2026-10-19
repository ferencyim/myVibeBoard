import { mkdtempSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { expectSystemTurn } from "../server/compaction/system-turn";

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
