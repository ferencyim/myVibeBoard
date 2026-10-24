import { describe, expect, it } from "vitest";
import { parseMemory } from "../server/memory/files";

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

describe("CRLF checkouts", () => {
  it("parses a CRLF project memory file like its LF twin", () => {
    const text = [
      "# Decisions",
      "",
      "<!-- vibe:entry id=d1 created=2026-01-01T00:00:00.000Z touched=2026-01-01T00:00:00.000Z -->",
      "Use SQLite.",
      "",
    ].join("\n");
    const lf = parseMemory(text);
    const cr = parseMemory(crlf(text));
    expect(cr.entries).toEqual(lf.entries);
    expect(cr.entries[0]!.body).toBe("Use SQLite.");
    expect(cr.preamble).toBe(lf.preamble);
  });
});
