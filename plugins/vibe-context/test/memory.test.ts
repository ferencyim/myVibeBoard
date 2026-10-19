import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTS_BLOCK_START,
  budgetFor,
  createIndexSink,
  createMemoryStore,
  dedupeEntries,
  demoteToBudget,
  estimateTokens,
  mergeAgentsMd,
  mergeGitignore,
  MemoryFormatError,
  MemoryPermissionError,
  parseMemoryFile,
  rebuildMemoryIndex,
  serializeMemoryFile,
  workerFile,
  type MemoryEntry,
} from "../server/memory";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";

const MASTER = { role: "master" } as const;

function setup(contextWindowTokens = 100_000, onChange?: Parameters<typeof createMemoryStore>[0]["onChange"]) {
  const root = mkdtempSync(join(tmpdir(), "vibe-mem-"));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const store = createMemoryStore({
    projectRoot: root,
    userHome: join(root, "home"),
    contextWindowTokens,
    now,
    onChange,
  });
  const read = (rel: string) => readFileSync(join(root, ".vibe", rel), "utf8");
  return { root, store, read };
}

const entry = (id: string, touched: number, body: string, tag = ""): MemoryEntry => ({
  id,
  created: new Date(Date.UTC(2026, 0, 1, 0, 0, touched)).toISOString(),
  touched: new Date(Date.UTC(2026, 0, 1, 0, 0, touched)).toISOString(),
  tag,
  body,
});

describe("entry format", () => {
  it("round-trips preamble and entries", () => {
    const f = { preamble: "# T\n\nnotes", entries: [entry("a", 1, "one\ntwo", "ui"), entry("b", 2, "x")] };
    expect(parseMemoryFile(serializeMemoryFile(f))).toEqual(f);
  });

  it("handles empty files and CRLF", () => {
    expect(parseMemoryFile("")).toEqual({ preamble: "", entries: [] });
    expect(serializeMemoryFile({ preamble: "", entries: [] })).toBe("");
    const crlf = serializeMemoryFile({ preamble: "# T", entries: [entry("a", 1, "l1\nl2")] }).replace(/\n/g, "\r\n");
    expect(parseMemoryFile(crlf).entries[0].body).toBe("l1\nl2");
  });

  it("rejects bodies that would forge a marker", () => {
    const bad = entry("a", 1, "x\n<!-- vibe:entry id=evil -->\ny");
    expect(() => serializeMemoryFile({ preamble: "", entries: [bad] })).toThrow(MemoryFormatError);
  });

  it("dedupes by normalized body keeping oldest id and newest touched", () => {
    const { entries, removedIds } = dedupeEntries([
      entry("a", 1, "Use  pnpm"),
      entry("b", 5, "use pnpm", "tooling"),
      entry("c", 2, "other"),
    ]);
    expect(removedIds).toEqual(["b"]);
    expect(entries.map((e) => e.id)).toEqual(["a", "c"]);
    expect(entries[0].touched).toBe(entry("x", 5, "").touched);
    expect(entries[0].tag).toBe("tooling");
  });
});

describe("budget demotion", () => {
  it("demotes least recently touched first, deterministically", () => {
    const body = "x".repeat(400); // ~100 tokens + marker
    const f = { preamble: "# T", entries: [entry("a", 3, body), entry("b", 1, body), entry("c", 2, body)] };
    const r = demoteToBudget(f, 380);
    expect(r.demoted.map((e) => e.id)).toEqual(["b", "c"].slice(0, r.demoted.length));
    expect(r.kept.map((e) => e.id)).toContain("a");
    expect(demoteToBudget(f, 380)).toEqual(r);
  });

  it("demotes a single oversized entry whole and keeps nothing lost", () => {
    const r = demoteToBudget({ preamble: "# T", entries: [entry("big", 1, "y".repeat(20_000))] }, 400);
    expect(r.kept).toEqual([]);
    expect(r.demoted).toHaveLength(1);
  });

  it("keeps everything when under budget or empty", () => {
    expect(demoteToBudget({ preamble: "", entries: [] }, 400)).toEqual({ kept: [], demoted: [] });
  });

  it("scales with the context window and has a floor", () => {
    expect(budgetFor("LESSONS.md", 1_000_000)).toBeGreaterThan(budgetFor("LESSONS.md", 200_000));
    expect(budgetFor("LESSONS.md", 1000)).toBe(400);
  });

  it("estimator counts CJK per character", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("中文测试")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

describe("memory store", () => {
  it("moves the oldest entries to *_ARCHIVE.md when over the limit", () => {
    const { store, read } = setup(4000); // LESSONS budget = 400 * 0.2 -> floor 400 tokens
    const body = "lesson text ".repeat(40); // ~120 tokens each
    const ids = [1, 2, 3, 4, 5].map((i) => store.addEntry(MASTER, "LESSONS.md", { body: `${body}${i}` }).entry!.id);
    const live = store.read("LESSONS.md");
    expect(live.tokens).toBeLessThanOrEqual(live.budget);
    const liveIds = live.entries.map((e) => e.id);
    const archived = store.readArchive("LESSONS.md").entries.map((e) => e.id);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived).toEqual(ids.slice(0, archived.length)); // oldest first
    expect([...archived, ...liveIds].sort()).toEqual([...ids].sort());
    expect(read("LESSONS_ARCHIVE.md")).toContain(ids[0]);
  });

  it("touching an entry protects it from demotion", () => {
    const { store } = setup(4000);
    const body = "lesson text ".repeat(25);
    const first = store.addEntry(MASTER, "LESSONS.md", { body: `${body}0` }).entry!;
    const second = store.addEntry(MASTER, "LESSONS.md", { body: `${body}1` }).entry!;
    store.addEntry(MASTER, "LESSONS.md", { body: `${body}2` });
    store.touch("LESSONS.md", [first.id]);
    const r = store.addEntry(MASTER, "LESSONS.md", { body: `${body}3` });
    expect(r.demoted.map((e) => e.id)[0]).toBe(second.id);
    expect(store.read("LESSONS.md").entries.map((e) => e.id)).toContain(first.id);
  });

  it("dedupes repeated additions and keeps the stable id", () => {
    const { store } = setup();
    const a = store.addEntry(MASTER, "LESSONS.md", { body: "Same lesson" }).entry!;
    const r = store.addEntry(MASTER, "LESSONS.md", { body: "same   lesson" });
    expect(r.dedupedIds).toHaveLength(1);
    expect(r.entry!.id).toBe(a.id);
    expect(store.read("LESSONS.md").entries).toHaveLength(1);
  });

  it("PROJECT_STATE is overwritten, id stable, never grows", () => {
    const { store } = setup();
    const a = store.writeProjectState(MASTER, "state v1").entry!;
    const b = store.writeProjectState(MASTER, "state v2").entry!;
    expect(b.id).toBe(a.id);
    const f = store.read("PROJECT_STATE.md");
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0].body).toBe("state v2");
  });

  it("oversized PROJECT_STATE keeps a truncated head and archives the full text", () => {
    const { store } = setup(1000);
    const huge = Array.from({ length: 400 }, (_, i) => `line ${i} of the state`).join("\n");
    const r = store.writeProjectState(MASTER, huge);
    expect(r.entry!.body).toContain("truncated");
    expect(store.read("PROJECT_STATE.md").tokens).toBeLessThanOrEqual(r.budget);
    expect(store.readArchive("PROJECT_STATE.md").entries[0].body).toBe(huge);
  });

  it("an oversized single lesson lands in the archive, not lost", () => {
    const { store } = setup(1000);
    const r = store.addEntry(MASTER, "LESSONS.md", { body: "z".repeat(10_000) });
    expect(r.entry).toBeNull();
    expect(store.read("LESSONS.md").entries).toEqual([]);
    expect(store.readArchive("LESSONS.md").entries).toHaveLength(1);
  });

  it("a new decision supersedes same-tag and explicit decisions", () => {
    const { store } = setup();
    const old1 = store.recordDecision(MASTER, { body: "use REST", tag: "api" }).entry!;
    const other = store.recordDecision(MASTER, { body: "use sqlite", tag: "db" }).entry!;
    const old2 = store.recordDecision(MASTER, { body: "tabs", tag: "style" }).entry!;
    const next = store.recordDecision(MASTER, { body: "use GraphQL", tag: "api", supersedes: [old2.id] }).entry!;
    const live = store.read("DECISIONS.md").entries.map((e) => e.id);
    expect(live).toEqual([other.id, next.id]);
    const arch = store.readArchive("DECISIONS.md").entries;
    expect(arch.map((e) => e.id).sort()).toEqual([old1.id, old2.id].sort());
    expect(arch[0].body).toContain(`superseded by ${next.id}`);
  });

  it("enforces who may write", () => {
    const { store } = setup();
    expect(() => store.writeProjectState({ role: "worker", agent: "claude" }, "x")).toThrow(MemoryPermissionError);
    expect(() => store.addEntry({ role: "user" }, "LESSONS.md", { body: "x" })).toThrow(MemoryPermissionError);
    expect(() => store.addEntry({ role: "worker", agent: "claude" }, "LESSONS.md", { body: "x" })).toThrow(
      MemoryPermissionError,
    );
    expect(() => store.addEntry({ role: "worker", agent: "codex" }, workerFile("claude"), { body: "x" })).toThrow(
      MemoryPermissionError,
    );
    expect(() => store.addEntry(MASTER, "PROJECT_STATE.md", { body: "x" })).toThrow(MemoryPermissionError);
    expect(() => store.addEntry(MASTER, "../evil.md" as never, { body: "x" })).toThrow(MemoryPermissionError);
    expect(() => workerFile("../x")).toThrow(MemoryPermissionError);
    store.addEntry({ role: "worker", agent: "claude" }, workerFile("claude"), { body: "my note" });
    expect(store.listWorkers()).toEqual(["claude"]);
  });

  it("reads user directives and ordered instructions; empty when absent", () => {
    const { root, store } = setup();
    expect(store.readUserDirectives()).toBeNull();
    expect(store.readInstructions()).toEqual([]);
    mkdirSync(join(root, "home", "user"), { recursive: true });
    writeFileSync(join(root, "home", "user", "user_directives.md"), "be brief");
    mkdirSync(join(root, ".vibe", "instructions"), { recursive: true });
    for (const n of ["zeta.md", "prd.md", "project_goals.md"]) {
      writeFileSync(join(root, ".vibe", "instructions", n), n);
    }
    expect(store.readUserDirectives()).toBe("be brief");
    expect(store.readInstructions().map((i) => i.name)).toEqual(["project_goals.md", "prd.md", "zeta.md"]);
  });

  it("re-budgets when the model window shrinks", () => {
    let window = 200_000;
    const root = mkdtempSync(join(tmpdir(), "vibe-mem-"));
    const store = createMemoryStore({ projectRoot: root, contextWindowTokens: () => window });
    for (let i = 0; i < 6; i++) store.addEntry(MASTER, "LESSONS.md", { body: `${"a".repeat(1500)}${i}` });
    const before = store.read("LESSONS.md").entries.length;
    window = 4000;
    const r = store.enforce(MASTER, "LESSONS.md");
    expect(r.demoted.length).toBeGreaterThan(0);
    expect(store.read("LESSONS.md").entries.length).toBeLessThan(before);
  });
});

describe("memory_entry index", () => {
  function db() {
    const d = openVibeDb({ path: ":memory:" });
    migrateOwner(d, "context");
    const project = createVibeStore(d).projects.create({ name: "P", prefix: "P", repoPath: "/tmp/p" });
    return { d, projectId: project.id };
  }
  const rows = (d: ReturnType<typeof openVibeDb>) =>
    d.prepare("SELECT id, file, archived, tokens FROM memory_entry ORDER BY file, archived, id").all();

  it("mirrors live and archived entries and flips archived on demotion", () => {
    const { d, projectId } = db();
    const root = mkdtempSync(join(tmpdir(), "vibe-mem-"));
    const wired = createMemoryStore({
      projectRoot: root,
      contextWindowTokens: 4000,
      onChange: createIndexSink(d, projectId),
    });
    const body = "lesson text ".repeat(40);
    for (let i = 0; i < 5; i++) wired.addEntry(MASTER, "LESSONS.md", { body: `${body}${i}` });
    const r = rows(d) as { id: string; file: string; archived: number }[];
    expect(r.filter((x) => x.archived === 0).map((x) => x.id).sort()).toEqual(
      wired.read("LESSONS.md").entries.map((e) => e.id).sort(),
    );
    expect(r.filter((x) => x.archived === 1)).toHaveLength(wired.readArchive("LESSONS.md").entries.length);
    expect(r.every((x) => x.file === "LESSONS.md")).toBe(true);
  });

  it("rebuilds the index from files, dropping stale rows", () => {
    const { d, projectId } = db();
    const root = mkdtempSync(join(tmpdir(), "vibe-mem-"));
    const store = createMemoryStore({ projectRoot: root, contextWindowTokens: 100_000 });
    store.writeProjectState(MASTER, "state");
    store.addEntry(MASTER, "LESSONS.md", { body: "l" });
    store.addEntry({ role: "worker", agent: "codex" }, workerFile("codex"), { body: "w" });
    d.prepare(
      "INSERT INTO memory_entry (id, project_id, file, tag, tokens, created_at, touched_at, archived) VALUES ('stale', ?, 'LESSONS.md', '', 1, 'x', 'x', 0)",
    ).run(projectId);
    rebuildMemoryIndex(d, projectId, store);
    const r = rows(d) as { id: string; file: string }[];
    expect(r.map((x) => x.file).sort()).toEqual(["LESSONS.md", "PROJECT_STATE.md", "workers/codex/MEMORY.md"]);
    expect(r.find((x) => x.id === "stale")).toBeUndefined();
    rebuildMemoryIndex(d, projectId, store);
    expect(rows(d)).toEqual(r);
  });
});

describe("repo files", () => {
  it("adds gitignore rules once", () => {
    const once = mergeGitignore("node_modules/\n");
    expect(once).toContain(".vibe/sessions/");
    expect(once).toContain(".vibe/workers/");
    expect(mergeGitignore(once)).toBe(once);
    expect(mergeGitignore("")).toMatch(/^# myVibeBoard/);
    expect(mergeGitignore("a")).toBe(mergeGitignore("a\n").replace(/^a\n/, "a\n"));
  });

  it("writes a single AGENTS.md guide block, idempotently", () => {
    const fresh = mergeAgentsMd("");
    expect(fresh).toContain(".vibe/");
    expect(mergeAgentsMd(fresh)).toBe(fresh);
    const existing = mergeAgentsMd("# Repo rules\n\nBe nice.\n");
    expect(existing.startsWith("# Repo rules")).toBe(true);
    expect(existing.split(AGENTS_BLOCK_START)).toHaveLength(2);
    expect(mergeAgentsMd(existing)).toBe(existing);
  });
});
