import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_PAYLOADS } from "../contract/events";
import { isSafeRepoRelativePath } from "../contract/paths";
import { ProjectSchema } from "../contract/model";
import { SYNC_TABLES } from "../contract/sync-spec";
import {
  CommandError,
  MIGRATIONS,
  RequirementsDocError,
  migrateAll,
  readEvents,
  readRequirementsDoc,
  writeRequirementsDoc,
} from "../db";
import { makeTempDir, openTestDb, setup } from "./helpers";

function seed() {
  const s = setup();
  const p = s.store.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "<repo>" });
  const card = s.store.cards.create({ projectId: p.id, title: "t", description: "d", column: "todo" });
  return { s, p, card };
}

describe("round 3 migration", () => {
  it("upgrades a v3 database: projectTypes / roleHints derived, card_event rebuilt, attachments kept", () => {
    const { db } = openTestDb();
    db.exec(
      "CREATE TABLE schema_version (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))",
    );
    for (const m of MIGRATIONS.core.slice(0, 3)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version VALUES ('core', ?, 'x')").run(m.version);
    }
    db.exec(`
      INSERT INTO project (id, name, prefix, repo_path, project_type, created_at, updated_at)
        VALUES ('pr1','A','AA','/r','android','t','t'), ('pr2','B','BB','/r','other','t','t');
      INSERT INTO preset (id, name, provider, model, role_hint, created_at, updated_at)
        VALUES ('s1','scout','claude','m','scout','t','t'), ('s2','free','claude','m','weird','t','t'),
               ('s3','none','claude','m',NULL,'t','t');
      INSERT INTO card (id, project_id, number, key, title, sort_key, created_at, updated_at)
        VALUES ('c1','pr1',1,'AA-1','t','a','t','t');
      INSERT INTO card_event (id, card_id, type, author_kind, body_json, created_at)
        VALUES ('e1','c1','note','agent','{"x":1}','t');
      INSERT INTO attachment (id, card_id, card_event_id, filename, mime_type, size_bytes, sha256, data, created_at)
        VALUES ('a1','c1','e1','f','text/plain',1,'h',x'00','t');
    `);
    migrateAll(db);
    const projects = db.prepare("SELECT id, project_types_json AS t, description, requirements_path AS r FROM project ORDER BY id").all();
    expect(projects).toEqual([
      { id: "pr1", t: '["android"]', description: "", r: "PRODUCT-REQUIREMENTS.md" },
      { id: "pr2", t: '["other"]', description: "", r: "PRODUCT-REQUIREMENTS.md" },
    ]);
    const presets = db.prepare("SELECT id, role_hint AS h, role_hints_json AS hs FROM preset ORDER BY id").all();
    expect(presets).toEqual([
      { id: "s1", h: "scout", hs: '["scout"]' },
      { id: "s2", h: null, hs: "[]" },
      { id: "s3", h: null, hs: "[]" },
    ]);
    // card_event rows and the attachment link survive the table rebuild (FK actions did not fire).
    expect(db.prepare("SELECT id, author_kind AS k FROM card_event").all()).toEqual([{ id: "e1", k: "agent" }]);
    expect(db.prepare("SELECT card_event_id AS e FROM attachment").get()).toEqual({ e: "e1" });
    // the new CHECK lists accept the new values
    db.exec(
      "INSERT INTO card_event (id, card_id, type, author_kind, created_at) VALUES ('e2','c1','chat','scout','t')",
    );
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});

describe("projects: projectTypes / description / requirementsPath", () => {
  it("defaults, and the COMPAT projectType always equals projectTypes[0]", () => {
    const { s, p } = seed();
    expect(p.projectTypes).toEqual(["other"]);
    expect(p.projectType).toBe("other");
    expect(p.description).toBe("");
    expect(p.requirementsPath).toBe("PRODUCT-REQUIREMENTS.md");
    const multi = s.store.projects.update(p.id, { projectTypes: ["web", "android", "web"] });
    expect(multi.projectTypes).toEqual(["web", "android"]);
    expect(multi.projectType).toBe("web");
    // old replica writes only projectType
    const old = s.store.projects.update(p.id, { projectType: "ios" });
    expect(old.projectTypes).toEqual(["ios"]);
    const created = s.store.projects.create({ name: "X", prefix: "XX", repoPath: "", projectType: "backend" });
    expect(created.projectTypes).toEqual(["backend"]);
    expect(() => s.store.projects.update(p.id, { projectTypes: [] })).toThrow(CommandError);
    expect(ProjectSchema.safeParse({ ...multi, projectTypes: ["web", "web"] }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...multi, projectTypes: [] }).success).toBe(false);
  });

  it("stamps the new fields for sync and validates requirementsPath", () => {
    const { s, p } = seed();
    const cols = s.db
      .prepare<{ column_name: string }>("SELECT column_name FROM sync_meta WHERE table_name='project' AND row_id=?")
      .all(p.id)
      .map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["project_type", "project_types_json", "description", "requirements_path"]));
    expect(s.store.projects.update(p.id, { requirementsPath: "docs/REQ.md", description: "d" })).toMatchObject({
      requirementsPath: "docs/REQ.md",
      description: "d",
    });
    for (const bad of ["/etc/passwd", "../x.md", "a/../../x", "C:\\x.md", ""])
      expect(() => s.store.projects.update(p.id, { requirementsPath: bad })).toThrow(CommandError);
    expect(isSafeRepoRelativePath("a/b.md")).toBe(true);
    const spec = SYNC_TABLES.find((t) => t.table === "project")!;
    expect(spec.fields).toContain("requirements_path");
  });
});

describe("presets: roleHints", () => {
  it("keeps roleHint as roleHints[0] and maps old single-value writes", () => {
    const { s } = seed();
    const a = s.store.presets.create({ name: "a", provider: "claude", model: "m" });
    expect(a.roleHints).toEqual([]);
    expect(a.roleHint).toBeNull();
    const b = s.store.presets.update(a.id, { roleHints: ["reviewer", "scout", "reviewer"] });
    expect(b.roleHints).toEqual(["reviewer", "scout"]);
    expect(b.roleHint).toBe("reviewer");
    expect(s.store.presets.update(a.id, { roleHint: "worker" }).roleHints).toEqual(["worker"]);
    expect(s.store.presets.update(a.id, { roleHint: null }).roleHints).toEqual([]);
    expect(s.store.presets.update(a.id, { roleHint: "whatever" }).roleHints).toEqual([]);
    expect(() => s.store.presets.update(a.id, { roleHints: ["bogus" as never] })).toThrow(CommandError);
    expect(s.store.presets.create({ name: "c", provider: "claude", model: "m", roleHint: "scout" }).roleHints).toEqual(["scout"]);
  });
});

describe("chat and proposal card events", () => {
  it("addChat stores a typed chat event", () => {
    const { s, card } = seed();
    const e = s.store.cards.addChat({
      cardId: card.id,
      authorKind: "executor",
      author: "claude",
      text: "which db?",
      sessionId: "s1",
      agentId: "ag1",
      kind: "question",
    });
    expect(e).toMatchObject({ type: "chat", authorKind: "executor", body: { text: "which db?", sessionId: "s1", agentId: "ag1", kind: "question" } });
    expect(() => s.store.cards.addChat({ cardId: card.id, authorKind: "user", text: "  " })).toThrow(CommandError);
    expect(s.store.events.list(card.id).map((x) => x.type)).toContain("chat");
  });

  it("propose supersedes older pending proposals; accept applies changes; reject only marks", () => {
    const { s, card } = seed();
    const p1 = s.store.cards.propose({ cardId: card.id, changes: { title: "T1" }, rationale: "r1" });
    expect(p1).toMatchObject({ type: "proposal", authorKind: "master", body: { status: "pending", changes: { title: "T1" } } });
    const p2 = s.store.cards.propose({ cardId: card.id, changes: { title: "T2", acceptance: "A2" }, rationale: "r2" });
    const status = (id: string) => (s.store.events.list(card.id).find((e) => e.id === id)!.body as { status: string }).status;
    expect(status(p1.id)).toBe("superseded");
    expect(status(p2.id)).toBe("pending");
    expect(() => s.store.cards.acceptProposal(p1.id, "user")).toThrow(CommandError);
    expect(() => s.store.cards.propose({ cardId: card.id, changes: {}, rationale: "x" })).toThrow(CommandError);

    const before = readEvents(s.db, 0, { limit: 1000 }).length;
    const accepted = s.store.cards.acceptProposal(p2.id, "user");
    expect(accepted.body).toMatchObject({ status: "accepted", resolvedBy: "user" });
    const after = s.store.cards.get(card.id)!;
    expect(after).toMatchObject({ title: "T2", acceptance: "A2", description: "d" });
    const updates = readEvents(s.db, before, { limit: 1000 }).filter((e) => e.type === "card.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.payload).toEqual({ fields: ["title", "acceptance"] });
    expect(() => s.store.cards.rejectProposal(p2.id, "user")).toThrow(CommandError);

    const p3 = s.store.cards.propose({ cardId: card.id, changes: { description: "D3" }, rationale: "r3" });
    s.store.cards.rejectProposal(p3.id, "phone");
    expect(status(p3.id)).toBe("rejected");
    expect(s.store.cards.get(card.id)!.description).toBe("d");
    // status change is a stamped body_json edit, so it syncs like any field
    const meta = s.db
      .prepare<{ hlc: string }>("SELECT hlc FROM sync_meta WHERE table_name='card_event' AND row_id=? AND column_name='body_json'")
      .get(p3.id);
    expect(meta?.hlc).toBeTruthy();
  });

  it("card.review_requested payload", () => {
    expect(EVENT_PAYLOADS["card.review_requested"].parse({ cardId: "c", requestedBy: "phone" })).toEqual({
      cardId: "c",
      requestedBy: "phone",
    });
    expect(() => EVENT_PAYLOADS["card.review_requested"].parse({ cardId: "c" })).toThrow();
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tempRepo(): string {
  const dir = makeTempDir("vibe-req-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("requirements-doc", () => {
  it("reads a missing file as empty with exists=false", () => {
    const dir = tempRepo();
    expect(readRequirementsDoc(dir, "PRODUCT-REQUIREMENTS.md")).toEqual({ path: "PRODUCT-REQUIREMENTS.md", exists: false, content: "" });
  });

  it("creates, commits only that file, keeps LF, and skips no-op writes", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, "other.txt"), "staged but unrelated\n");
    git(dir, "add", "other.txt");
    const r = await writeRequirementsDoc(dir, "docs/REQ.md", "a\r\nb\r\n", "docs: add requirements");
    expect(r).toMatchObject({ committed: true, created: true, exists: true, path: "docs/REQ.md" });
    expect(readFileSync(join(dir, "docs/REQ.md"), "utf8")).toBe("a\nb\n");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("docs: add requirements");
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("docs/REQ.md");
    expect(git(dir, "status", "--porcelain")).toBe("A  other.txt"); // unrelated staged file untouched
    expect(r.commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(readRequirementsDoc(dir, "docs/REQ.md").content).toBe("a\nb\n");

    const same = await writeRequirementsDoc(dir, "docs/REQ.md", "a\nb\n", "noop");
    expect(same).toMatchObject({ committed: false, commit: null, created: false });
    const changed = await writeRequirementsDoc(dir, "docs/REQ.md", "a\nc\n", "docs: edit");
    expect(changed).toMatchObject({ committed: true, created: false });
    expect(git(dir, "log", "--format=%s", "-3")).toBe("docs: edit\ndocs: add requirements\ninit");
  });

  it("rejects traversal and absolute paths", async () => {
    const dir = tempRepo();
    for (const bad of ["../x.md", "a/../../x.md", "/abs.md", "C:\\abs.md", ""]) {
      await expect(writeRequirementsDoc(dir, bad, "x", "m")).rejects.toMatchObject({ code: "invalid_path" });
      expect(() => readRequirementsDoc(dir, bad)).toThrow(RequirementsDocError);
    }
  });

  it("refuses an ignored path", async () => {
    const dir = tempRepo();
    writeFileSync(join(dir, ".gitignore"), "ignored.md\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "ignore");
    await expect(writeRequirementsDoc(dir, "ignored.md", "x", "m")).rejects.toMatchObject({ code: "ignored" });
    expect(existsSync(join(dir, "ignored.md"))).toBe(false);
  });

  it("refuses while a merge, rebase or cherry-pick is in progress", async () => {
    const dir = tempRepo();
    const gitDir = join(dir, ".git");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge"]) {
      if (marker === "rebase-merge") mkdirSync(join(gitDir, marker));
      else writeFileSync(join(gitDir, marker), "0000000000000000000000000000000000000000\n");
      await expect(writeRequirementsDoc(dir, "REQ.md", "x", "m")).rejects.toMatchObject({ code: "repo_busy" });
      expect(existsSync(join(dir, "REQ.md"))).toBe(false);
      if (marker !== "rebase-merge") (await import("node:fs")).unlinkSync(join(gitDir, marker));
    }
  });

  it("uses an injected runner (no real git)", async () => {
    const dir = makeTempDir("vibe-req-fake-");
    mkdirSync(join(dir, ".git"));
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
      if (args[0] === "check-ignore") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "ls-files") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: "A  REQ.md\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await writeRequirementsDoc(dir, "REQ.md", "x", "msg", runner);
    expect(r.commit).toBe("abc123");
    expect(calls.map((c) => c[0])).toEqual(["rev-parse", "check-ignore", "ls-files", "add", "status", "commit", "rev-parse"]);
    expect(calls.find((c) => c[0] === "commit")).toEqual(["commit", "-m", "msg", "--", "REQ.md"]);
  });
});
