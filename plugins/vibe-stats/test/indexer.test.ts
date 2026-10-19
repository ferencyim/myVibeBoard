import { readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeOverview } from "../server/aggregate";
import { createIndexer } from "../server/indexer";
import {
  CLAUDE_FIXTURE,
  CODEX_HEAD,
  CODEX_TAIL,
  DEEPSEEK_FIXTURE,
  KIMI_FIXTURE,
  append,
  claudeLine,
  lines,
  openTestDb,
  rootsFor,
  tempDir,
  write,
} from "./helpers";

interface EventRow {
  provider: string;
  model: string;
  session_id: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  duration_ms: number | null;
  cost: number | null;
}

function setup() {
  const base = tempDir();
  const db = openTestDb();
  const indexer = createIndexer({ db, roots: () => rootsFor(base) });
  const events = (provider?: string) =>
    db
      .prepare<EventRow>(
        `SELECT * FROM usage_event ${provider ? "WHERE provider = ?" : ""} ORDER BY id`,
      )
      .all(...(provider ? [provider] : []));
  return { base, db, indexer, events };
}

const claudeFile = (base: string) => join(base, "claude", "projects", "proj-a", "sess.jsonl");
const codexFile = (base: string) =>
  join(base, "codex", "sessions", "2026", "10", "01", "rollout-2026-10-01T11-00-00-abc.jsonl");

describe("claude parser + dedupe", () => {
  it("counts each message once, skips synthetic and invalid lines", async () => {
    const { base, indexer, events } = setup();
    write(claudeFile(base), CLAUDE_FIXTURE);
    await indexer.scan();
    const rows = events("claude");
    expect(rows).toHaveLength(3);
    const sum = (k: keyof EventRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
    expect(sum("tokens_in")).toBe(115);
    expect(sum("tokens_out")).toBe(455);
    expect(sum("tokens_cache_read")).toBe(2200);
    expect(sum("tokens_cache_write")).toBe(200);
    // msg_1 spans from the preceding user line (10:00:00) to its last chunk (10:00:06).
    expect(rows.map((r) => r.duration_ms)).toEqual([6000, 10000, 5000]);
    expect(rows[0]?.session_id).toBe("sess-claude-1");
    expect(rows.every((r) => r.cost !== null && r.cost > 0)).toBe(true);
  });

  it("reads only appended bytes and ignores a partial last line", async () => {
    const { base, db, indexer, events } = setup();
    const file = claudeFile(base);
    write(file, CLAUDE_FIXTURE);
    await indexer.scan();
    const cursor = db.prepare<{ byte_offset: number }>("SELECT byte_offset FROM usage_cursor").get();
    expect(cursor?.byte_offset).toBe(readFileSync(file).length);

    const next = JSON.stringify(claudeLine("2026-10-01T10:05:00.000Z", "msg_9", "req_9", [1, 2, 3, 4]));
    append(file, next.slice(0, 40)); // half a line: must wait
    expect((await indexer.scan()).events).toBe(0);
    append(file, next.slice(40) + "\n");
    expect((await indexer.scan()).events).toBe(1);
    expect(events("claude")).toHaveLength(4);
  });

  it("is idempotent when cursors are lost and survives truncation", async () => {
    const { base, indexer, events } = setup();
    const file = claudeFile(base);
    write(file, CLAUDE_FIXTURE);
    await indexer.scan();
    indexer.resetCursors();
    await indexer.scan();
    expect(events("claude")).toHaveLength(3);
    truncateSync(file, 10);
    await indexer.scan(); // size < offset: restart from 0, nothing parses, nothing breaks
    expect(events("claude")).toHaveLength(3);
  });
});

describe("codex parser", () => {
  it("uses last_token_usage, subtracts cached input, skips repeated totals", async () => {
    const { base, indexer, events } = setup();
    write(codexFile(base), CODEX_HEAD + CODEX_TAIL);
    await indexer.scan();
    const rows = events("codex");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.tokens_in, r.tokens_cache_read, r.tokens_out])).toEqual([
      [200, 800, 100],
      [800, 1200, 200],
    ]);
    expect(rows[0]).toMatchObject({ model: "gpt-5-codex", session_id: "sess-codex-1" });
  });

  it("restores session id and model after a restart (new indexer, same db)", async () => {
    const { base, db, indexer, events } = setup();
    write(codexFile(base), CODEX_HEAD);
    await indexer.scan();
    expect(events("codex")).toHaveLength(1);
    const restarted = createIndexer({ db, roots: () => rootsFor(base) });
    append(codexFile(base), CODEX_TAIL);
    await restarted.scan();
    const rows = events("codex");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ model: "gpt-5-codex", session_id: "sess-codex-1" });
  });
});

describe("kimi and deepseek parsers (tolerant)", () => {
  it("indexes StatusUpdate token_usage once per message id", async () => {
    const { base, indexer, events } = setup();
    write(join(base, "kimi", "sessions", "hash", "sess-k", "wire.jsonl"), KIMI_FIXTURE);
    await indexer.scan();
    const rows = events("kimi");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: "sess-k",
      tokens_in: 50,
      tokens_out: 20,
      tokens_cache_read: 100,
      tokens_cache_write: 10,
    });
  });

  it("indexes deepseek-style usage objects", async () => {
    const { base, indexer, events } = setup();
    write(join(base, "dsh", "sessions", "s.jsonl"), DEEPSEEK_FIXTURE);
    await indexer.scan();
    expect(events("deepseek")[0]).toMatchObject({
      session_id: "sess-ds-1",
      tokens_in: 40,
      tokens_out: 40,
      tokens_cache_read: 60,
      duration_ms: 4000,
    });
  });
});

// Independent re-statement of ccusage's Claude algorithm: one entry per message.id:requestId pair
// (entries lacking either id are all kept), skipping lines without message.usage, summed per day.
function ccusageStyleDaily(file: string) {
  const seen = new Set<string>();
  const days = new Map<string, number[]>();
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") continue;
    if (o.message.model === "<synthetic>") continue;
    if (o.message.id && o.requestId) {
      const hash = `${o.message.id}:${o.requestId}`;
      if (seen.has(hash)) continue;
      seen.add(hash);
    }
    const d = new Date(o.timestamp);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const t = days.get(day) ?? [0, 0, 0, 0];
    t[0] += u.input_tokens;
    t[1] += u.output_tokens;
    t[2] += u.cache_creation_input_tokens ?? 0;
    t[3] += u.cache_read_input_tokens ?? 0;
    days.set(day, t);
  }
  return days;
}

describe("reconciliation with ccusage", () => {
  it("daily token totals match the ccusage algorithm on the fixture", async () => {
    const { base, db, indexer } = setup();
    const file = claudeFile(base);
    write(
      file,
      CLAUDE_FIXTURE +
        lines(claudeLine("2026-10-02T09:00:00.000Z", "msg_d2", "req_d2", [7, 8, 9, 10])),
    );
    await indexer.scan();
    const overview = computeOverview(db, "all");
    const expected = ccusageStyleDaily(file);
    expect(overview.byDay.map((d) => d.key)).toEqual([...expected.keys()].sort());
    for (const day of overview.byDay) {
      const [input, output, cacheCreate, cacheRead] = expected.get(day.key) ?? [];
      expect([day.input, day.output, day.cacheWrite, day.cacheRead]).toEqual([
        input,
        output,
        cacheCreate,
        cacheRead,
      ]);
    }
    expect(overview.totals).toMatchObject({ input: 122, output: 463, cacheRead: 2209, cacheWrite: 210 });
  });
});
