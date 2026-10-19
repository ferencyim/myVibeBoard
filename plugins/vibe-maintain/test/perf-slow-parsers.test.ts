import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregate,
  fingerprintSql,
  normalizeSite,
  parseBenchJson,
  parseJsonl,
  parseMysqlSlow,
  parsePgLog,
  readSource,
} from "../server/checks/perf-slow";
import { tempDir } from "./helpers";

describe("perf-slow parsers", () => {
  it("normalizes call sites and SQL", () => {
    expect(normalizeSite("/items/123/comments/9f8e7d6c-1234-5678-9abc-def012345678?page=2")).toBe("/items/:id/comments/:id");
    expect(fingerprintSql("SELECT * FROM t WHERE id = 42 AND name = 'bob''s' AND k IN (1, 2, 3) -- c")).toBe(
      "SELECT * FROM t WHERE id = ? AND name = ? AND k IN (?)",
    );
  });

  it("parses JSON lines with default and configured field names", () => {
    const text = [
      '{"route":"/a/1","duration_ms":120.5,"method":"get","time":"2026-10-19T01:00:00Z"}',
      '{"url":"/a/2?x=1","elapsed":0.9,"ts":1760000000}',
      "not json",
      '{"route":"/b"}',
    ].join("\n");
    expect(parseJsonl(text).map((s) => [s.site, s.ms])).toEqual([["GET /a/:id", 120.5], ["/a/:id", 0.9]]);
    const custom = parseJsonl(text, { site: "url", ms: "elapsed", ts: "ts" }, "s");
    expect(custom).toEqual([{ site: "/a/:id", ms: 900, ts: "2025-10-09T08:53:20.000Z" }]);
  });

  it("parses hyperfine, vitest bench and generic benchmark JSON", () => {
    expect(parseBenchJson(JSON.stringify({ results: [{ command: "node a.js", mean: 0.25 }] }))).toEqual([{ site: "node a.js", ms: 250 }]);
    const vitest = { files: [{ filepath: "/x/y/sort.bench.ts", groups: [{ benchmarks: [{ name: "sort 1k", mean: 3.2 }] }] }] };
    expect(parseBenchJson(JSON.stringify(vitest))).toEqual([{ site: "sort.bench.ts > sort 1k", ms: 3.2 }]);
    expect(parseBenchJson(JSON.stringify([{ name: "q", ms: 7 }, { name: "bad" }]))).toEqual([{ site: "q", ms: 7 }]);
    expect(parseBenchJson("{")).toEqual([]);
  });

  it("parses MySQL slow log blocks and leaves an unfinished tail", () => {
    const log = [
      "# Time: 2026-10-19T01:02:03.000000Z",
      "# User@Host: app[app] @ localhost []  Id: 5",
      "# Query_time: 2.500000  Lock_time: 0.000100 Rows_sent: 1  Rows_examined: 100000",
      "use shop;",
      "SET timestamp=1760835723;",
      "SELECT * FROM orders WHERE user_id = 77",
      "  ORDER BY created_at;",
      "# Time: 2026-10-19T01:02:09.000000Z",
      "# Query_time: 1.000000  Lock_time: 0.0 Rows_sent: 1  Rows_examined: 5",
      "SELECT 1",
    ].join("\n");
    const { samples, consumed } = parseMysqlSlow(`${log}\n`);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ site: "SELECT * FROM orders WHERE user_id = ? ORDER BY created_at", ms: 2500 });
    expect(log.slice(consumed).startsWith("# Time: 2026-10-19T01:02:09")).toBe(true);
    const done = parseMysqlSlow(`${log};\n`);
    expect(done.samples).toHaveLength(2);
    expect(done.consumed).toBe(`${log};\n`.length);
  });

  it("parses PostgreSQL duration lines with continuation", () => {
    const log = [
      "2026-10-19 01:02:03.123 UTC [1234] LOG:  duration: 2500.123 ms  statement: SELECT * FROM a",
      "\tWHERE id = 5",
      "2026-10-19 01:02:04.000 UTC [1234] LOG:  duration: 10.000 ms  execute <unnamed>: SELECT 2",
      "2026-10-19 01:02:05.000 UTC [1234] LOG:  checkpoint starting",
    ].join("\n");
    const s = parsePgLog(log);
    expect(s.map((x) => [x.site, x.ms])).toEqual([
      ["SELECT * FROM a WHERE id = ?", 2500.123],
      ["SELECT ?", 10],
    ]);
    expect(s[0]!.ts).toBe("2026-10-19T01:02:03.123Z");
  });

  it("aggregates per site", () => {
    const stats = aggregate([{ site: "a", ms: 10 }, { site: "a", ms: 600 }, { site: "b", ms: 1 }], 500);
    expect(stats.find((x) => x.site === "a")).toMatchObject({ count: 2, slowCount: 1, maxMs: 600 });
  });
});

describe("readSource incremental reads", () => {
  const source = { kind: "jsonl" as const, path: "x", threshold_ms: 1, min_count: 1, unit: "ms" };

  it("advances the offset, only returns appended complete lines and restarts after truncation", async () => {
    const dir = tempDir();
    const file = join(dir, "log.jsonl");
    writeFileSync(file, '{"route":"/a","ms":5}\n{"route":"/b","ms":6}\n{"route":"/c","ms"');
    const first = (await readSource(source, file, undefined))!;
    expect(first.samples.map((s) => s.site)).toEqual(["/a", "/b"]);
    appendFileSync(file, ':7}\n{"route":"/d","ms":8}\n');
    const second = (await readSource(source, file, first.next))!;
    expect(second.samples.map((s) => s.site)).toEqual(["/c", "/d"]);
    expect((await readSource(source, file, second.next))!.samples).toEqual([]);
    writeFileSync(file, '{"route":"/e","ms":9}\n');
    expect((await readSource(source, file, second.next))!.samples.map((s) => s.site)).toEqual(["/e"]);
    expect(await readSource(source, join(dir, "missing.jsonl"), undefined)).toBeNull();
  });

  it("reads a bench file again only when its mtime changes", async () => {
    const dir = tempDir();
    const file = join(dir, "bench.json");
    writeFileSync(file, JSON.stringify([{ name: "q", ms: 7 }]));
    const bench = { ...source, kind: "bench-json" as const };
    const first = (await readSource(bench, file, undefined))!;
    expect(first.samples).toHaveLength(1);
    expect((await readSource(bench, file, first.next))!.samples).toHaveLength(0);
  });
});
