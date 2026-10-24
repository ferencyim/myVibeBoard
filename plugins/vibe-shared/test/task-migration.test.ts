import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  OWNERS,
  createTaskRuntimeCommands,
  getSchemaVersion,
  migrateAll,
  migrateOwner,
  openVibeDb,
  readEvents,
  type VibeDb,
} from "../db";
import { backupVibeDb } from "../db/backup";
import { openTestDb, setup } from "./helpers";

import {
  legacyFixture,
  maintenanceCounts,
  preCutoverSchema,
  snapshot,
  timestamp,
} from "./legacy-fixture";

function backupFiles(path: string) {
  const dir = join(dirname(path), "backups");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
}

describe("WP-114 legacy cutover", () => {
  it("keeps all retained contents and rule × project counts, without importing seven projects' three cards", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const before = snapshot(db);
    const counts = maintenanceCounts(db);
    expect(before.project).toHaveLength(7);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(migrateOwner(db, "core")).toMatchObject({ from: 10, to: 15, applied: [11, 12, 13, 14, 15] });
    expect(snapshot(db)).toEqual(before);
    expect(maintenanceCounts(db)).toEqual(counts);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
    for (const table of [
      "git_snapshot",
      "card",
      "card_event",
      "card_tag",
      "attachment",
      "plan_version",
      "tag",
      "sync_meta",
      "sync_tombstone",
      "sync_field",
      "sync_tomb",
    ])
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
      ).toBeUndefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const backups = backupFiles(path);
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(backups[0]!, { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM project").get()).toEqual({ n: 7 });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(
      backup.prepare("SELECT branch,diff_stat FROM git_snapshot WHERE project_id='p1'").get(),
    ).toEqual({ branch: "legacy-branch", diff_stat: "旧看板缓存" });
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name = 'task'").get(),
    ).toBeUndefined();
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    db.close();
    const restarted = openVibeDb({ path });
    migrateAll(restarted);
    expect(migrateAll(restarted).every((r) => r.applied.length === 0)).toBe(true);
    expect(snapshot(restarted)).toEqual(before);
    expect(backupFiles(path)).toEqual(backups);
    restarted.close();
  });

  it("rolls back the new table and schema version when migration fails after DDL", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const before = snapshot(db);
    const failing: VibeDb = {
      ...db,
      prepare(sql) {
        if (sql.startsWith("INSERT INTO schema_version")) throw new Error("模拟版本写入失败");
        return db.prepare(sql);
      },
    };
    expect(() => migrateOwner(failing, "core")).toThrow("模拟版本写入失败");
    expect(getSchemaVersion(db, "core")).toBe(10);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task'").get()).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    expect(backupFiles(path)).toHaveLength(1);
    db.close();
  });

  it("stops before changing the old schema when a consistent backup cannot be created", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const before = snapshot(db);
    writeFileSync(join(dirname(path), "backups"), "阻止目录创建");
    expect(() => migrateOwner(db, "core")).toThrow();
    expect(getSchemaVersion(db, "core")).toBe(10);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task'").get()).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  it("backs up committed WAL data read-only under the selected VIBE_HOME, with unique timestamped names", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    const reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM vibe_meta").get();
    db.prepare("INSERT INTO vibe_meta VALUES ('committed-in-wal','保留WAL')").run();
    const before = snapshot(db);
    const options = { vibeHome: dirname(path), now: () => new Date(timestamp) };
    const first = backupVibeDb(db, options);
    const second = backupVibeDb(db, options);
    expect(first).toContain(join(dirname(path), "backups"));
    expect(first).toContain("2026-10-23T12-00-00.000Z");
    expect(first).not.toBe(second);
    const backup = new DatabaseSync(first, { readOnly: true });
    expect(
      backup.prepare("SELECT value FROM vibe_meta WHERE key='committed-in-wal'").get(),
    ).toEqual({ value: "保留WAL" });
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    expect(snapshot(db)).toEqual(before);
    reader.exec("ROLLBACK");
    reader.close();
    db.close();
  });

  it("creates a fresh empty task table without making a needless backup", () => {
    const { db, path } = openTestDb();
    migrateAll(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
    expect(backupFiles(path)).toEqual([]);
    db.close();
  });

  it("backs up v13 before deleting cards, while retaining task history, members, artifacts and evidence", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    preCutoverSchema(db);
    db.exec(`
      INSERT INTO task(workspace_id,anchor_agent_id,conversation_id) VALUES ('workspace','native-agent','conversation');
      INSERT INTO task_artifact(workspace_id,kind,source_key,source_json,summary,created_at)
        VALUES ('workspace','plan','source','{}','保留方案','now');
      INSERT INTO agent_session(id,card_id,agent_id,workspace_id,role,current_provider,last_activity_at,started_at)
        VALUES ('legacy-session','c1','old-agent',NULL,'worker','codex','now','now'),
               ('task-session',NULL,'native-agent','workspace','planner','codex','now','now');
      INSERT INTO verification(id,card_id,commit_hash,mode,started_at)
        VALUES ('legacy-check','c1','commit','evidence','now');
      INSERT INTO verification(id,workspace_id,confirmed_at,project_id,commit_hash,mode,started_at)
        VALUES ('task-check','workspace','confirmed','p1','commit','evidence','now');
      INSERT INTO verification_item(id,verification_id,check_text)
        VALUES ('legacy-item','legacy-check','旧验证'),('task-item','task-check','保留验证');
      INSERT INTO evidence_file(id,verification_id,item_id,kind,path,sha256,captured_at,commit_hash)
        VALUES ('legacy-evidence','legacy-check','legacy-item','log','old','hash','now','commit'),
               ('task-evidence','task-check','task-item','log','task','hash','now','commit');
    `);
    const before = snapshot(db);
    const tables = [
      "task",
      "task_artifact",
      "agent_session",
      "verification",
      "verification_item",
      "evidence_file",
    ];
    const isNewRow = (row: Record<string, unknown>) => !String(row.id ?? "").startsWith("legacy-");
    const stripTabs =
      (name: string) =>
      (row: Record<string, unknown>): Record<string, unknown> =>
        name === "task"
          ? Object.fromEntries(
              Object.entries(row).filter(([key]) => !["tabs_json", "next_tab_number"].includes(key)),
            )
          : row;
    const surviving = Object.fromEntries(
      tables.map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table}`).all().filter(isNewRow).map(stripTabs(table)),
      ]),
    );
    migrateOwner(db, "core");
    expect(snapshot(db)).toEqual(before);
    for (const table of tables)
      expect(db.prepare(`SELECT * FROM ${table}`).all().map(stripTabs(table))).toEqual(
        surviving[table],
      );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_list(agent_session)").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_list(verification)").all()).not.toContainEqual(
      expect.objectContaining({ table: "card" }),
    );
    const backup = new DatabaseSync(backupFiles(path)[0]!, { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM evidence_file").get()).toEqual({ n: 2 });
    expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    backup.close();
    db.close();
  });

  it("keeps the v13 schema and all card data when backup fails immediately before cutover", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    preCutoverSchema(db);
    const before = snapshot(db);
    writeFileSync(join(dirname(path), "backups"), "阻止备份目录");
    expect(() => migrateOwner(db, "core")).toThrow();
    expect(getSchemaVersion(db, "core")).toBe(13);
    expect(getSchemaVersion(db, "verify")).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(snapshot(db)).toEqual(before);
    db.close();
  });

  it("rolls back both owners and legacy evidence if the final DROP transaction cannot commit", () => {
    const { db, path } = openTestDb();
    legacyFixture(db);
    preCutoverSchema(db);
    db.exec(
      "INSERT INTO verification(id,card_id,commit_hash,mode,started_at) VALUES ('legacy','c1','commit','evidence','now'); INSERT INTO verification_item(id,verification_id,check_text) VALUES ('item','legacy','旧验证')",
    );
    const failing: VibeDb = {
      ...db,
      exec(sql) {
        db.exec(sql);
        if (sql.includes("DROP TABLE card;")) throw new Error("模拟DROP后失败");
      },
    };
    expect(() => migrateOwner(failing, "core")).toThrow("模拟DROP后失败");
    expect(getSchemaVersion(db, "core")).toBe(13);
    expect(getSchemaVersion(db, "verify")).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM card").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM verification_item").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(backupFiles(path)).toHaveLength(1);
    db.close();
  });

  it.each(OWNERS)(
    "allows %s to start first on an old database without leaving readers of deleted tables",
    (owner) => {
      const { db } = openTestDb();
      legacyFixture(db);
      migrateOwner(db, owner);
      for (const current of OWNERS)
        expect(getSchemaVersion(db, current)).toBe(MIGRATIONS[current].at(-1)?.version);
      expect(migrateAll(db).every((result) => result.applied.length === 0)).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    },
  );

  it.each([1, 3, 8, 10, 11, 12, 13])(
    "upgrades core v%s even when no other plugin has initialized its owner tables",
    (version) => {
      const { db } = openTestDb();
      db.exec(
        "CREATE TABLE schema_version(owner TEXT,version INTEGER,applied_at TEXT,PRIMARY KEY(owner,version))",
      );
      for (const migration of MIGRATIONS.core.filter((entry) => entry.version <= version)) {
        if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_version VALUES ('core',?,'legacy')").run(migration.version);
        if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
      }
      migrateOwner(db, "core");
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'card'").get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM task").get()).toEqual({ n: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrateAll(db).every((result) => result.applied.length === 0)).toBe(true);
      db.close();
    },
  );
});

describe("WP-112 retained runtime migration", () => {
  it("registers all task roles and atomically deduplicates continuations with actual model attribution", () => {
    const { db } = openTestDb();
    migrateAll(db);
    const runtime = createTaskRuntimeCommands(db);
    const old = runtime.registerSession({
      workspaceId: "w",
      projectId: "p",
      agentId: "a",
      role: "plan_reviewer",
      provider: "codex",
      model: "first",
      candidateIndex: 0,
      confirmedAt: "confirmed",
    });
    expect(
      runtime.registerSession({
        workspaceId: "w",
        agentId: "a",
        role: "plan_reviewer",
        provider: "codex",
        model: "first",
        candidateIndex: 0,
      }).id,
    ).toBe(old.id);
    const input = {
      fromSessionId: old.id,
      agentId: "b",
      provider: "claude",
      model: "next",
      thinking: "high",
      candidateIndex: 1,
      reason: "继续",
    };
    const next = runtime.recordContinuation(input);
    expect(next.from.state).toBe("ended");
    expect(next.to).toMatchObject({
      workspaceId: "w",
      projectId: "p",
      previousSessionId: old.id,
      confirmedAt: "confirmed",
    });
    expect(runtime.recordContinuation(input).to.id).toBe(next.to.id);
    expect(runtime.getContinuation(old.id)?.id).toBe(next.to.id);
    expect(() => runtime.recordContinuation({ ...input, agentId: "duplicate" })).toThrow(
      "请停止重复创建",
    );
    expect(runtime.findSessionByAgent("duplicate")).toBeUndefined();
    expect(runtime.getSelection(next.to.id)).toEqual({
      candidateIndex: 1,
      actualModel: { provider: "claude", model: "next", thinking: "high" },
    });
    for (const role of ["scout", "reviewer"] as const)
      expect(
        runtime.registerSession({
          workspaceId: "w",
          agentId: role,
          role,
          provider: "codex",
          model: "m",
          candidateIndex: 0,
        }).role,
      ).toBe(role);
    expect(runtime.listSessions({ workspaceId: "w" })).toHaveLength(4);
    db.close();
  });
});

describe("completed native task member restoration", () => {
  function fixture(outcome: string | undefined = "completed") {
    const state = setup();
    state.store.tasks.create({
      workspaceId: "resume",
      anchorAgentId: "backend",
      conversationId: "conversation",
    });
    const runtime = createTaskRuntimeCommands(state.db, { now: () => new Date(state.clock.ms) });
    const session = runtime.registerSession({
      workspaceId: "resume",
      agentId: "backend",
      role: "verifier",
      provider: "codex",
      model: "test",
      candidateIndex: 0,
      confirmedAt: null,
    });
    state.store.sessions.setState(session.id, "ended", { outcome });
    const input = {
      workspaceId: "resume",
      agentId: "backend",
      role: "verifier" as const,
      confirmedAt: null,
    };
    return { ...state, runtime, session, input };
  }
  it("restores a completed leaf to idle atomically and does not duplicate events or relax the global terminal state", () => {
    const s = fixture();
    expect(() => s.store.sessions.setState(s.session.id, "idle")).toThrow(/cannot go/);
    const events = readEvents(s.db, 0);
    s.tick();
    const resumed = s.runtime.resumeCompletedSession(s.session.id, s.input);
    expect(resumed).toMatchObject({
      state: "idle",
      endedAt: null,
      confirmedAt: null,
      lastActivityAt: new Date(s.clock.ms).toISOString(),
    });
    expect(readEvents(s.db, 0)).toHaveLength(events.length + 1);
    expect(readEvents(s.db, 0).at(-1)).toMatchObject({
      type: "task.updated",
      payload: { workspaceId: "resume", fields: ["sessions"] },
    });
    expect(readEvents(s.db, 0).filter((event) => event.type === "session.started")).toHaveLength(1);
    expect(s.runtime.resumeCompletedSession(s.session.id, s.input)).toEqual(resumed);
    s.store.sessions.setState(s.session.id, "working");
    expect(s.runtime.resumeCompletedSession(s.session.id, s.input).state).toBe("working");
    expect(readEvents(s.db, 0)).toHaveLength(events.length + 1);
    s.db.close();
  });
  it("atomically links a normally completed native member to the current confirmation round", () => {
    const s = fixture();
    const preset = s.store.presets.create({ name: "冻结预设", provider: "codex", model: "test" });
    s.store.modelDefaults.setGlobal({ planner: preset.id, worker: preset.id, verifier: preset.id });
    s.tick();
    const task = s.store.tasks.confirm("resume", {
      plan: {
        goal: "再次执行",
        approach: "复用已完成成员",
        files: [],
        subtasks: [],
        checks: [{ text: "可恢复", method: "单测" }],
      },
      rolesSnapshot: s.store.modelDefaults.resolveTask({}),
      planSource: {
        conversationId: "conversation",
        sourceKey: "planner:new",
        memberId: "planner",
        backendAgentId: "backend",
      },
      requestId: "new-round",
    });
    expect(s.runtime.getSession(s.session.id)?.confirmedAt).toBeNull();
    expect(
      s.runtime.resumeCompletedSession(s.session.id, { ...s.input, confirmedAt: task.confirmedAt }),
    ).toMatchObject({ state: "idle", confirmedAt: task.confirmedAt, endedAt: null });
    expect(s.store.sessions.list({ states: ["idle"] }).map((session) => session.id)).toContain(
      s.session.id,
    );
    s.db.close();
  });
  it("rejects failed, canceled or missing completion evidence without changing the session", () => {
    for (const outcome of ["failed", "canceled", ""]) {
      const s = fixture(outcome);
      const ended = s.runtime.getSession(s.session.id);
      const events = readEvents(s.db, 0);
      expect(() => s.runtime.resumeCompletedSession(s.session.id, s.input)).toThrow(
        /正常完成.*证据/,
      );
      expect(s.runtime.getSession(s.session.id)).toEqual(ended);
      expect(readEvents(s.db, 0)).toEqual(events);
      s.db.close();
    }
    const s = fixture();
    s.db.prepare("DELETE FROM vibe_event WHERE type = 'session.ended'").run();
    expect(() => s.runtime.resumeCompletedSession(s.session.id, s.input)).toThrow(/正常完成.*证据/);
    s.db.close();
  });
  it("rejects a legacy card, mismatched identities, changed task round and a continuation replacement", () => {
    const s = fixture();
    for (const patch of [
      { workspaceId: "other" },
      { agentId: "other" },
      { role: "worker" as const },
    ])
      expect(() =>
        s.runtime.resumeCompletedSession(s.session.id, { ...s.input, ...patch }),
      ).toThrow(/同一任务/);
    expect(() =>
      s.runtime.resumeCompletedSession(s.session.id, {
        ...s.input,
        confirmedAt: "2026-10-23T12:00:00.000Z",
      }),
    ).toThrow(/确认已变化/);
    s.runtime.recordContinuation({
      fromSessionId: s.session.id,
      agentId: "replacement",
      provider: "codex",
      model: "next",
      candidateIndex: 1,
      reason: "继续",
    });
    expect(() => s.runtime.resumeCompletedSession(s.session.id, s.input)).toThrow(/接续替代者/);
    expect(s.runtime.getSession(s.session.id)?.state).toBe("ended");
    s.db.close();
  });
  it("rolls back restoration when its task notification cannot commit", () => {
    const s = fixture();
    s.db.exec(
      "CREATE TRIGGER fail_restore_event BEFORE INSERT ON vibe_event WHEN NEW.type = 'task.updated' BEGIN SELECT RAISE(ABORT, '模拟恢复通知失败'); END",
    );
    expect(() => s.runtime.resumeCompletedSession(s.session.id, s.input)).toThrow(
      /模拟恢复通知失败/,
    );
    expect(s.runtime.getSession(s.session.id)).toMatchObject({
      state: "ended",
      endedAt: new Date(s.clock.ms).toISOString(),
    });
    s.db.close();
  });
});
