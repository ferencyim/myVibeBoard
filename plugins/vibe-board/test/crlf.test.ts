import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handoffFile, loadHandoff } from "../server/dispatch/handoff";

describe("CRLF checkouts", () => {
  it("returns the planning hand-off file without carriage returns", () => {
    const repo = mkdtempSync(join(tmpdir(), "vibe-board-crlf-"));
    const card = { key: "DEMO-1" };
    mkdirSync(join(repo, ".vibe", "sessions"), { recursive: true });
    writeFileSync(handoffFile(repo, card.key), "# Plan\r\n\r\n1. Do it\r\n2. Test it\r\n");
    expect(loadHandoff({ repoPath: repo }, card, [])?.text).toBe("# Plan\n\n1. Do it\n2. Test it");
  });
});
