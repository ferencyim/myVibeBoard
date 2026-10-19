import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeOverview } from "../server/aggregate";
import { createIndexer } from "../server/indexer";
import { CLAUDE_FIXTURE, openTestDb, rootsFor, tempDir, write } from "./helpers";

describe("CRLF logs", () => {
  it("indexes a CRLF usage log with the same totals as the LF one", async () => {
    const totalsOf = async (text: string) => {
      const base = tempDir();
      const db = openTestDb();
      write(join(base, "claude", "projects", "p", "s.jsonl"), text);
      await createIndexer({ db, roots: () => rootsFor(base) }).scan();
      const { totals } = computeOverview(db, "all");
      return { input: totals.input, output: totals.output, events: totals.events };
    };
    const lf = await totalsOf(CLAUDE_FIXTURE);
    expect(lf.events).toBeGreaterThan(0);
    expect(await totalsOf(CLAUDE_FIXTURE.replace(/\n/g, "\r\n"))).toEqual(lf);
  });
});
