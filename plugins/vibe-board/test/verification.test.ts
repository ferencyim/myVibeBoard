import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HEADLINES,
  aggregate,
  canDecide,
  checkRejection,
  conclusionOf,
  countsLine,
  dataUri,
  evidenceForItem,
  fileName,
  needsAttention,
  previewKind,
  provenance,
  simulatedNotice,
  textExcerpt,
  unattachedEvidence,
} from "../client/verification/logic";
import { registerBoardRpcs } from "../server/rpc";
import { createVerifyService, MAX_EVIDENCE_BYTES } from "../server/verify";
import { migrateOwner, readEvents } from "../server/vibe/db";
import type { EvidenceFile } from "../shared/vibe/contract";
import * as rpc from "../shared/rpc";
import { setupBoard, tempDir } from "./helpers";

const ev = (over: Partial<EvidenceFile> & { id: string }): EvidenceFile => ({
  verificationId: "v1",
  itemId: null,
  kind: "screenshot",
  path: "/e/shot.png",
  thumbPath: null,
  sha256: "",
  capturedAt: "2026-10-19T14:03:09.000Z",
  commitHash: "0123456789abcdef",
  simulated: false,
  ...over,
});

type J = "pass" | "doubt" | "fail" | null;

describe("conclusion and attention", () => {
  it("aggregates fail > doubt/unjudged > pass", () => {
    expect(aggregate(["pass", "pass"])).toBe("pass");
    expect(aggregate(["pass", "doubt"])).toBe("doubt");
    expect(aggregate(["pass", null])).toBe("doubt");
    expect(aggregate(["doubt", "fail"])).toBe("fail");
    expect(aggregate([])).toBe("doubt");
  });

  it("picks the headline: recorded, running, derived, none", () => {
    const run = (conclusion: J, finishedAt: string | null, js: J[] = []) =>
      conclusionOf({ verification: { conclusion, finishedAt }, items: js.map((judgement) => ({ judgement })) });
    expect(run("fail", "t")).toBe("fail");
    expect(run(null, null)).toBe("running");
    expect(run(null, "t", ["pass", "doubt"])).toBe("doubt");
    expect(conclusionOf(null)).toBe("none");
    expect(HEADLINES.pass).toBe("全部通过");
    expect(HEADLINES.doubt).toBe("有存疑");
    expect(HEADLINES.fail).toBe("有失败");
  });

  it("highlights failed, doubtful and (once finished) unjudged items only", () => {
    expect(needsAttention({ judgement: "pass" })).toBe(false);
    expect(needsAttention({ judgement: "doubt" })).toBe(true);
    expect(needsAttention({ judgement: "fail" })).toBe(true);
    expect(needsAttention({ judgement: null }, true)).toBe(true);
    expect(needsAttention({ judgement: null }, false)).toBe(false);
  });

  it("summarises counts", () => {
    expect(
      countsLine([{ judgement: "pass" }, { judgement: "pass" }, { judgement: "doubt" }, { judgement: null }]),
    ).toBe("4 项检查 · 2 通过 · 1 存疑 · 1 待判");
  });
});

describe("evidence helpers", () => {
  const a = ev({ id: "a", itemId: "i1" });
  const b = ev({ id: "b" });
  const c = ev({ id: "c", kind: "log", path: "/e/run.log" });

  it("groups evidence per item (by id list or tag) and leaves the rest unattached", () => {
    const items = [
      { id: "i1", evidenceIds: [] },
      { id: "i2", evidenceIds: ["b"] },
    ];
    expect(evidenceForItem(items[0]!, [a, b, c]).map((e) => e.id)).toEqual(["a"]);
    expect(evidenceForItem(items[1]!, [a, b, c]).map((e) => e.id)).toEqual(["b"]);
    expect(unattachedEvidence(items, [a, b, c]).map((e) => e.id)).toEqual(["c"]);
  });

  it("takes the file name from posix and windows paths", () => {
    expect(fileName("/e/run1/shot.png")).toBe("shot.png");
    expect(fileName("D:\\vibe\\run1\\npm-test.log")).toBe("npm-test.log");
  });

  it("classifies previews", () => {
    expect(previewKind(a)).toBe("image");
    expect(previewKind(ev({ id: "g", kind: "gif", path: "/e/x.gif" }))).toBe("gif");
    expect(previewKind(ev({ id: "v", kind: "video", path: "/e/x.mp4" }))).toBe("video");
    expect(previewKind(c)).toBe("text");
    expect(previewKind(ev({ id: "o", kind: "report", path: "/e/x.bin" }))).toBe("text");
    expect(previewKind(ev({ id: "p", kind: "photo", path: "/e/x.bin" }))).toBe("other");
  });

  it("prints capture time, commit and the simulated flag", () => {
    expect(provenance(a)).toBe("2026-10-19 14:03 · commit 0123456");
    expect(provenance(ev({ id: "s", simulated: true }))).toBe("2026-10-19 14:03 · commit 0123456 · 仿真取证");
    expect(simulatedNotice([a, b])).toBeNull();
    expect(simulatedNotice([a, ev({ id: "s", simulated: true })])).toMatch(/^1 份证据为仿真取证/);
    expect(simulatedNotice([ev({ id: "s", simulated: true })])).toMatch(/^全部证据为仿真取证/);
  });

  it("builds data URIs and cuts long text excerpts", () => {
    expect(dataUri("image/png", "QUJD")).toBe("data:image/png;base64,QUJD");
    const long = Buffer.from("x".repeat(5000)).toString("base64");
    expect(textExcerpt(long, 10)).toEqual({ text: "x".repeat(10), truncated: true });
    expect(textExcerpt(Buffer.from("日志 ok").toString("base64"))).toEqual({ text: "日志 ok", truncated: false });
  });

  it("allows decisions only in verifying and rejects blank comments", () => {
    expect(canDecide("verifying")).toBe(true);
    expect(canDecide("done")).toBe(false);
    expect(checkRejection("  ")).toEqual({ ok: false, message: "请写一句驳回意见" });
    expect(checkRejection(" fix it ")).toEqual({ ok: true, comment: "fix it" });
  });
});

describe("verification service (reads vibe-verify tables, queues decisions)", () => {
  function setup() {
    const { runtime, board } = setupBoard();
    const home = tempDir("vibe-home-");
    board.projects.create({ name: "D", prefix: "VER", repoPath: "/tmp/d", projectType: "web" });
    const { card } = board.cards.create({ project: "VER", title: "Check me", column: "todo" });
    const service = createVerifyService({ db: runtime.db, board, home });
    return { runtime, board, home, card, service };
  }
  type Ctx = ReturnType<typeof setup>;

  function seed(ctx: Ctx, over: { thumb?: boolean; bytes?: number } = {}) {
    const dir = tempDir("vibe-evidence-");
    const shot = join(dir, "shot.png");
    writeFileSync(shot, Buffer.from("PNGDATA"));
    const thumb = join(dir, "shot.thumb.png");
    writeFileSync(thumb, Buffer.from("THUMB"));
    writeFileSync(join(dir, "big.mp4"), Buffer.alloc(over.bytes ?? 1));
    const { db } = ctx.runtime;
    db.prepare(
      `INSERT INTO verification (id, card_id, commit_hash, conclusion, mode, started_at, finished_at)
       VALUES ('v1', ?, 'abcdef1234', 'doubt', 'evidence', '2026-10-19T14:00:00.000Z', '2026-10-19T14:05:00.000Z')`,
    ).run(ctx.card.id);
    db.prepare(
      `INSERT INTO verification_item (id, verification_id, position, check_text, method, judgement, note, evidence_ids_json)
       VALUES ('i1', 'v1', 0, 'Home renders', 'screenshot', 'doubt', 'Looks off', '["e1"]')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence_file (id, verification_id, item_id, kind, path, thumb_path, sha256, captured_at, commit_hash, simulated)
       VALUES ('e1', 'v1', 'i1', 'screenshot', ?, ?, '', '2026-10-19T14:03:00.000Z', 'abcdef1234', 1)`,
    ).run(shot, over.thumb === false ? null : thumb);
    db.prepare(
      `INSERT INTO evidence_file (id, verification_id, item_id, kind, path, thumb_path, sha256, captured_at, commit_hash, simulated)
       VALUES ('e2', 'v1', NULL, 'video', ?, NULL, '', '2026-10-19T14:04:00.000Z', 'abcdef1234', 0)`,
    ).run(join(dir, "big.mp4"));
    mkdirSync(join(ctx.home, "verify", "notes"), { recursive: true });
    writeFileSync(join(ctx.home, "verify", "notes", "v1.json"), JSON.stringify(["Android emulator only"]));
  }

  function toVerifying(ctx: Ctx) {
    ctx.runtime.store.cards.dispatch({ cardId: ctx.card.id, agentId: "a1", provider: "claude", worktree: null });
    ctx.board.cards.move(ctx.card.id, { to: "verifying", actor: "lifecycle" });
  }

  it("returns nothing before vibe-verify has created its tables, then the detail with notes", () => {
    const ctx = setup();
    expect(ctx.service.get(ctx.card.key)).toEqual({ detail: null });
    expect(ctx.service.list(ctx.card.key)).toEqual({ verifications: [] });
    migrateOwner(ctx.runtime.db, "verify");
    seed(ctx);
    const { detail } = rpc.verifyGetRpc.output.parse(ctx.service.get(ctx.card.key));
    expect(detail?.summary).toBe("Some checks are doubtful");
    expect(detail?.items.map((i) => i.id)).toEqual(["i1"]);
    expect(detail?.items[0]?.evidenceIds).toEqual(["e1"]);
    expect(detail?.evidence.map((e) => [e.id, e.simulated])).toEqual([
      ["e1", true],
      ["e2", false],
    ]);
    expect(detail?.notes).toEqual(["Android emulator only"]);
    expect(ctx.service.list(ctx.card.key).verifications).toHaveLength(1);
    expect(ctx.service.get(ctx.card.key, "nope")).toEqual({ detail: null });
  });

  it("serves the thumbnail when asked, else the original; refuses big or missing files", () => {
    const ctx = setup();
    migrateOwner(ctx.runtime.db, "verify");
    seed(ctx, { bytes: MAX_EVIDENCE_BYTES + 1 });
    const decode = (r: { base64: string }) => Buffer.from(r.base64, "base64").toString();
    expect(decode(ctx.service.evidence("e1", true))).toBe("THUMB");
    expect(decode(ctx.service.evidence("e1"))).toBe("PNGDATA");
    expect(ctx.service.evidence("e1", true).mimeType).toBe("image/png");
    expect(() => ctx.service.evidence("e2")).toThrow(/\[too_large\]/);
    expect(() => ctx.service.evidence("zzz")).toThrow(/\[not_found\]/);
  });

  it("falls back to the original when the evidence has no thumbnail", () => {
    const ctx = setup();
    migrateOwner(ctx.runtime.db, "verify");
    seed(ctx, { thumb: false });
    expect(Buffer.from(ctx.service.evidence("e1", true).base64, "base64").toString()).toBe("PNGDATA");
  });

  it("approve moves verifying -> done; reject/rerun queue events for vibe-verify; others conflict", () => {
    const ctx = setup();
    migrateOwner(ctx.runtime.db, "verify");
    expect(() => ctx.service.approve(ctx.card.key)).toThrow(/\[conflict\]/);
    expect(() => ctx.service.reject(ctx.card.key, "no")).toThrow(/\[conflict\]/);
    toVerifying(ctx);
    expect(ctx.service.reject(ctx.card.key, "Button is misaligned")).toEqual({ ok: true });
    expect(ctx.service.rerun(ctx.card.key)).toEqual({ queued: true });
    const requests = readEvents(ctx.runtime.db, 0, { types: ["verification.decision_requested"] });
    expect(requests.map((e) => e.payload)).toEqual([
      { action: "reject", comment: "Button is misaligned" },
      { action: "rerun" },
    ]);
    expect(requests.every((e) => e.cardId === ctx.card.id)).toBe(true);
    expect(ctx.service.approve(ctx.card.key)).toEqual({ ok: true });
    expect(ctx.board.cards.get(ctx.card.key).column).toBe("done");
    expect(() => ctx.service.approve(ctx.card.key)).toThrow(/\[conflict\]/);
  });

  it("is registered as vibe.verify.* RPCs only when a service is given", () => {
    const { board, runtime } = setupBoard();
    const handled: string[] = [];
    const server = { handle: (def: { name: string }) => handled.push(def.name) } as never;
    registerBoardRpcs(server, board, { verify: createVerifyService({ db: runtime.db, board }) });
    for (const def of Object.values(rpc.VIBE_VERIFY_UI_RPCS)) expect(handled).toContain(def.name);
  });
});
