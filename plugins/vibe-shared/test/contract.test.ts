import { describe, expect, it } from "vitest";
import {
  EvidenceArtifactSchema,
  CollectResultSchema,
  CARD_KEY_PATTERN,
  PROJECT_PREFIX_PATTERN,
  SYNC_TABLES,
  compareHlc,
  createCollectorRegistry,
  createScriptedRunner,
  formatHlc,
  isUlid,
  newId,
  parseHlc,
  sortKeyAfter,
  sortKeyBetween,
  syncSpec,
  tickHlc,
  type CollectorContext,
  type EvidenceCollector,
} from "../contract";
import {
  AgentSessionSchema,
  CardEventSchema,
  CardViewSchema,
  GitSnapshotSchema,
  MaintenanceRuleSchema,
  MaintenanceRunSchema,
  PlanVersionSchema,
  PresetSchema,
  ProjectSchema,
  TagSchema,
  UsageEventSchema,
  VerificationItemSchema,
  VerificationSchema,
  EvidenceFileSchema,
  DeviceLeaseSchema,
  DeviceSchema,
  MemoryEntrySchema,
  ResourceSampleSchema,
} from "../contract/model";
import { decodeRow, migrateOwner } from "../db";
import { openTestDb, setup } from "./helpers";

describe("ids", () => {
  it("generates valid, strictly increasing ULIDs even within one millisecond", () => {
    const ids = Array.from({ length: 2000 }, () => newId(1_700_000_000_000));
    expect(ids.every(isUlid)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    expect(newId(1_700_000_001_000) > ids.at(-1)!).toBe(true);
  });
});

describe("hlc", () => {
  it("formats, parses and orders as plain strings", () => {
    const a = formatHlc({ wall: 1_700_000_000_000, counter: 0, node: "dev-a" });
    expect(parseHlc(a)).toEqual({ wall: 1_700_000_000_000, counter: 0, node: "dev-a" });
    expect(() => parseHlc("garbage")).toThrow();
    const b = tickHlc(a, 1_700_000_000_000, "dev-a"); // same ms -> counter
    const c = tickHlc(b, 1_600_000_000_000, "dev-a"); // clock went back -> still increases
    const d = tickHlc(c, 1_800_000_000_000, "dev-a");
    expect([compareHlc(a, b), compareHlc(b, c), compareHlc(c, d)]).toEqual([-1, -1, -1]);
    expect(compareHlc("", a)).toBe(-1);
    // counter ordering must not be lexicographic-by-decimal
    expect(
      compareHlc(
        formatHlc({ wall: 1, counter: 9, node: "x" }),
        formatHlc({ wall: 1, counter: 10, node: "x" }),
      ),
    ).toBe(-1);
  });

  it("rolls the wall component when the counter overflows", () => {
    const max = formatHlc({ wall: 5, counter: 0xffff, node: "n" });
    const next = tickHlc(max, 1, "n");
    expect(compareHlc(max, next)).toBe(-1);
    expect(parseHlc(next)).toMatchObject({ wall: 6, counter: 0 });
  });
});

describe("sort keys", () => {
  it("generates ordered keys at the end, start and in the middle, without trailing zeros", () => {
    let last: string | null = null;
    const appended: string[] = [];
    for (let i = 0; i < 100; i++) {
      last = sortKeyAfter(last);
      appended.push(last);
    }
    expect(appended).toEqual([...appended].sort());
    expect(new Set(appended).size).toBe(100);

    const keys = ["a", "b"];
    for (let i = 0; i < 200; i++) {
      // repeatedly insert between the first two keys
      const k = sortKeyBetween(keys[0]!, keys[1]!);
      expect(k > keys[0]! && k < keys[1]!).toBe(true);
      keys.splice(1, 0, k);
    }
    expect(keys).toEqual([...keys].sort());
    expect(sortKeyBetween(null, "a")! < "a").toBe(true);
    expect(sortKeyBetween("a", "ab")).toMatch(/^a[01]*[1-9a-z]$/);
    expect(() => sortKeyBetween("b", "a")).toThrow();
    expect([...keys, ...appended].every((k) => !k.endsWith("0"))).toBe(true);
  });

  it("random insertions always keep a strict total order", () => {
    const list: string[] = [sortKeyAfter(null)];
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 500; i++) {
      const at = Math.floor(rnd() * (list.length + 1));
      const key = sortKeyBetween(list[at - 1] ?? null, list[at] ?? null);
      list.splice(at, 0, key);
    }
    for (let i = 1; i < list.length; i++) expect(list[i - 1]! < list[i]!).toBe(true);
  });
});

describe("patterns", () => {
  it("validates prefixes and card keys", () => {
    expect(PROJECT_PREFIX_PATTERN.test("DEMO")).toBe(true);
    expect(PROJECT_PREFIX_PATTERN.test("demo")).toBe(false);
    expect(PROJECT_PREFIX_PATTERN.test("1ABC")).toBe(false);
    expect(CARD_KEY_PATTERN.exec("ABC-12")?.[2]).toBe("12");
  });
});

describe("zod contract round trips", () => {
  it("every domain schema accepts rows read through the db layer and survives JSON", () => {
    const s = setup();
    const { store, db } = s;
    migrateOwner(db, "verify");
    migrateOwner(db, "context");
    migrateOwner(db, "scheduler");
    migrateOwner(db, "stats");
    migrateOwner(db, "maintain");

    const preset = store.presets.create({ name: "P", provider: "claude", model: "opus" });
    const project = store.projects.create({
      name: "n",
      prefix: "RT",
      repoPath: "r",
      projectType: "android",
      defaultPresetId: preset.id,
      devices: ["emu-1"],
      concurrencyLimit: 2,
    });
    const card = store.cards.create({
      projectId: project.id,
      title: "t",
      column: "todo",
      tagIds: ["tag_feature"],
      refImages: ["x.png"],
    });
    const { session } = store.cards.dispatch({
      cardId: card.id,
      agentId: "ag",
      provider: "claude",
      worktree: "<wt>",
    });
    const ev = store.events.add({
      cardId: card.id,
      type: "note",
      authorKind: "user",
      body: { a: 1 },
    });
    const plan = store.plans.save(card.id, {
      description: "d",
      checks: [],
      subCards: [],
      tags: [],
      recommendedPresetId: null,
    });
    const snap = store.gitSnapshots.upsert({
      projectId: project.id,
      branch: "m",
      ahead: 0,
      behind: 0,
      dirtyFiles: 0,
      diffStat: "",
    });

    const roundTrip = <T>(schema: { parse(v: unknown): T }, value: unknown): T =>
      schema.parse(JSON.parse(JSON.stringify(value)));
    expect(roundTrip(ProjectSchema, project)).toEqual(project);
    expect(roundTrip(PresetSchema, preset)).toEqual(preset);
    expect(roundTrip(CardViewSchema, store.cards.get(card.id))).toEqual(store.cards.get(card.id));
    expect(roundTrip(AgentSessionSchema, session)).toEqual(session);
    expect(roundTrip(CardEventSchema, ev)).toEqual(ev);
    expect(roundTrip(PlanVersionSchema, plan)).toEqual(plan);
    expect(roundTrip(GitSnapshotSchema, snap)).toEqual(snap);
    expect(roundTrip(TagSchema, store.tags.list()[0])).toEqual(store.tags.list()[0]);

    // tables owned by other plugins decode through the same generic mapper
    const now = "2026-01-01T00:00:00.000Z";
    db.prepare(
      "INSERT INTO verification (id, card_id, commit_hash, mode, started_at) VALUES ('v1', ?, 'abc', 'evidence', ?)",
    ).run(card.id, now);
    db.prepare(
      "INSERT INTO verification_item (id, verification_id, check_text, evidence_ids_json) VALUES ('i1','v1','works','[\"e1\"]')",
    ).run();
    db.prepare(
      "INSERT INTO evidence_file (id, verification_id, item_id, kind, path, sha256, captured_at, commit_hash, simulated) VALUES ('e1','v1','i1','screenshot','/p','h',?, 'abc', 1)",
    ).run(now);
    db.prepare(
      "INSERT INTO memory_entry (id, project_id, file, created_at, touched_at) VALUES ('m1', ?, 'PROJECT_STATE.md', ?, ?)",
    ).run(project.id, now, now);
    db.prepare(
      "INSERT INTO resource_sample (ts, cpu, mem, per_session_json) VALUES (?, 0.5, 0.25, '{\"a\":1}')",
    ).run(now);
    db.prepare(
      "INSERT INTO device (id, kind, name, created_at) VALUES ('d1','emulator','Pixel',?)",
    ).run(now);
    db.prepare("INSERT INTO device_lease (id, device_id, acquired_at) VALUES ('l1','d1',?)").run(
      now,
    );
    db.prepare(
      "INSERT INTO usage_event (ts, provider, model, session_id, dedupe_key) VALUES (?, 'claude','opus','s','k')",
    ).run(now);
    db.prepare(
      "INSERT INTO maintenance_rule (id, project_id, name, trigger_kind, created_at, updated_at) VALUES ('r1', ?, 'git-health','workload',?,?)",
    ).run(project.id, now, now);
    db.prepare(
      "INSERT INTO maintenance_run (id, rule_id, project_id, triggered_at, card_ids_json) VALUES ('mr1','r1',?,?,'[\"c\"]')",
    ).run(project.id, now);

    const get = (table: string) => db.prepare(`SELECT * FROM ${table}`).get()!;
    expect(decodeRow(VerificationSchema, get("verification"))).toMatchObject({
      conclusion: null,
      mode: "evidence",
    });
    expect(decodeRow(VerificationItemSchema, get("verification_item"))).toMatchObject({
      evidenceIds: ["e1"],
      judgement: null,
    });
    expect(decodeRow(EvidenceFileSchema, get("evidence_file"))).toMatchObject({
      simulated: true,
      kind: "screenshot",
    });
    expect(decodeRow(MemoryEntrySchema, get("memory_entry"))).toMatchObject({ archived: false });
    expect(decodeRow(ResourceSampleSchema, get("resource_sample"))).toMatchObject({
      perSession: { a: 1 },
    });
    expect(decodeRow(DeviceSchema, get("device"))).toMatchObject({ kind: "emulator" });
    expect(decodeRow(DeviceLeaseSchema, get("device_lease"))).toMatchObject({ releasedAt: null });
    expect(decodeRow(UsageEventSchema, get("usage_event"))).toMatchObject({ tokensIn: 0 });
    expect(decodeRow(MaintenanceRuleSchema, get("maintenance_rule"))).toMatchObject({
      enabled: true,
      outputMode: "suggest",
    });
    expect(decodeRow(MaintenanceRunSchema, get("maintenance_run"))).toMatchObject({
      cardIds: ["c"],
      status: "running",
    });
  });

  it("device leases are exclusive while active", () => {
    const { db } = openTestDb();
    migrateOwner(db, "scheduler");
    db.prepare(
      "INSERT INTO device (id, kind, name, created_at) VALUES ('d','emulator','e','t')",
    ).run();
    db.prepare("INSERT INTO device_lease (id, device_id, acquired_at) VALUES ('l1','d','t')").run();
    expect(() =>
      db
        .prepare("INSERT INTO device_lease (id, device_id, acquired_at) VALUES ('l2','d','t')")
        .run(),
    ).toThrow(/UNIQUE/);
    db.prepare("UPDATE device_lease SET released_at = 't2' WHERE id = 'l1'").run();
    db.prepare(
      "INSERT INTO device_lease (id, device_id, acquired_at) VALUES ('l2','d','t3')",
    ).run();
  });

  it("usage events are idempotent by dedupe_key", () => {
    const { db } = openTestDb();
    migrateOwner(db, "stats");
    const ins = () =>
      db
        .prepare(
          "INSERT OR IGNORE INTO usage_event (ts, provider, model, session_id, dedupe_key) VALUES ('t','p','m','s','same')",
        )
        .run();
    expect(ins().changes).toBe(1);
    expect(ins().changes).toBe(0);
  });
});

describe("sync spec", () => {
  it("lists every table exactly once and marks the bidirectional ones", () => {
    const names = SYNC_TABLES.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
    expect(
      SYNC_TABLES.filter((t) => t.direction === "both")
        .map((t) => t.table)
        .sort(),
    ).toEqual(
      ["card", "card_event", "card_tag", "maintenance_rule", "preset", "project", "prompt_override", "tag"].sort(),
    );
    expect(syncSpec("card")?.fields).toContain("column");
    expect(syncSpec("usage_event")?.direction).toBe("local");
    expect(syncSpec("verification")?.direction).toBe("down");
    expect(syncSpec("nope")).toBeUndefined();
  });
});

describe("collector interfaces", () => {
  const ctxBase = (runner: CollectorContext["runner"]): CollectorContext => ({
    cardId: "c",
    verificationId: "v",
    projectType: "web",
    projectPath: "<repo>",
    worktreePath: "<wt>",
    commitHash: "abc",
    outputDir: "<out>",
    runner,
    now: () => new Date(0),
    log: () => undefined,
  });

  const fake: EvidenceCollector = {
    id: "fake-web",
    projectTypes: ["web", "backend"],
    async detect(ctx) {
      const r = await ctx.runner.run("browser", ["--version"]);
      return r.exitCode === 0 ? { available: true } : { available: false, reason: "no browser" };
    },
    async collect(ctx) {
      await ctx.runner.run("browser", ["shot", ctx.outputDir], {
        cwd: ctx.worktreePath,
        timeoutMs: 1000,
      });
      return {
        artifacts: [
          {
            kind: "screenshot",
            path: `${ctx.outputDir}/a.png`,
            capturedAt: ctx.now().toISOString(),
            commitHash: ctx.commitHash,
            simulated: false,
          },
        ],
        judgement: "pass",
        notes: [],
        degraded: false,
      };
    },
  };

  it("registers collectors, looks them up by project type and rejects duplicates", () => {
    const reg = createCollectorRegistry();
    reg.register(fake);
    expect(() => reg.register(fake)).toThrow(/already registered/);
    expect(reg.forProjectType("web")).toHaveLength(1);
    expect(reg.forProjectType("android")).toHaveLength(0);
    expect(reg.get("fake-web")).toBe(fake);
    expect(reg.list()).toHaveLength(1);
  });

  it("a collector runs against a scripted Runner and its result satisfies the zod contract", async () => {
    const runner = createScriptedRunner((call) =>
      call.args[0] === "--version" ? { exitCode: 127 } : undefined,
    );
    const ctx = ctxBase(runner);
    expect(await fake.detect(ctx)).toEqual({ available: false, reason: "no browser" });
    const result = await fake.collect(ctx);
    expect(runner.calls.map((c) => c.args[0])).toEqual(["--version", "shot"]);
    expect(runner.calls[1]?.options).toMatchObject({ cwd: "<wt>", timeoutMs: 1000 });
    expect(CollectResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(
      EvidenceArtifactSchema.safeParse({ ...result.artifacts[0], kind: "hologram" }).success,
    ).toBe(false);
  });

  it("scripted runner defaults to a successful empty result", async () => {
    const runner = createScriptedRunner(() => undefined);
    expect(await runner.run("x", [])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      durationMs: 0,
    });
  });
});
