import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../server/config";
import { parseJsonl, parseMysqlSlow, parsePgLog } from "../server/checks/perf-slow";
import { tempDir } from "./helpers";

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

describe("CRLF checkouts", () => {
  it("loads a CRLF maintenance.yml like its LF twin", async () => {
    const yml = [
      "rules:",
      "  - name: nightly-clean",
      "    trigger: { kind: time, cron: '0 3 * * *' }",
      "    check: { type: git }",
      "    output: suggest",
      "    agent: codex/gpt-6",
      "",
    ].join("\n");
    const load = async (text: string) => {
      const repo = tempDir();
      mkdirSync(join(repo, ".vibe"), { recursive: true });
      writeFileSync(join(repo, ".vibe", "maintenance.yml"), text);
      return loadConfig(repo);
    };
    const lf = await load(yml);
    const cr = await load(crlf(yml));
    expect(cr.errors).toEqual([]);
    expect(cr.yml).toEqual(lf.yml);
    expect(cr.yml.map((r) => [r.name, r.fields.agent])).toEqual([["nightly-clean", "codex/gpt-6"]]);
  });

  it("parses CRLF slow-query logs with the same samples", () => {
    const mysql = [
      "# Time: 2026-10-19T01:02:03.000000Z",
      "# Query_time: 2.500000  Lock_time: 0.000100 Rows_sent: 1  Rows_examined: 100000",
      "use shop;",
      "SET timestamp=1760835723;",
      "SELECT * FROM orders WHERE id = 7;",
      "",
    ].join("\n");
    expect(parseMysqlSlow(crlf(mysql)).samples).toEqual(parseMysqlSlow(mysql).samples);
    expect(parseMysqlSlow(crlf(mysql)).samples).toHaveLength(1);

    const pg = "2026-10-19 01:02:03 UTC [1] LOG:  duration: 2500.123 ms  statement: SELECT 1 FROM t WHERE id = 5\n";
    expect(parsePgLog(crlf(pg))).toEqual(parsePgLog(pg));
    const jsonl = '{"route":"/a/1","duration_ms":120.5}\n{"route":"/b/2","duration_ms":9}\n';
    expect(parseJsonl(crlf(jsonl))).toEqual(parseJsonl(jsonl));
  });
});
