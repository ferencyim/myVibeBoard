import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import { createVerifyStore } from "../server/store";
import { createVibeStore, migrateOwner, openVibeDb } from "../server/vibe/db";
import { THUMB_MAX_WIDTH, thumbnailPng, writeThumbnail } from "../server/thumbnail";
import { solidPng } from "./helpers";

const dir = mkdtempSync(path.join(tmpdir(), "vibe-thumb-"));
afterAll(() => {
  for (const name of readdirSync(dir)) unlinkSync(path.join(dir, name));
  rmdirSync(dir);
});

describe("thumbnails", () => {
  it("scales a wide PNG to the max width, keeping the aspect ratio and color", () => {
    const out = PNG.sync.read(thumbnailPng(solidPng(1080, 2400, [200, 30, 60])));
    expect(out.width).toBe(THUMB_MAX_WIDTH);
    expect(out.height).toBe(Math.round((2400 * THUMB_MAX_WIDTH) / 1080));
    expect([...out.data.subarray(0, 4)]).toEqual([200, 30, 60, 255]);
  });

  it("leaves small PNGs alone and writes <name>.thumb.png next to the original", () => {
    const small = solidPng(100, 50, [1, 2, 3]);
    expect(thumbnailPng(small)).toBe(small);
    const file = path.join(dir, "shot.png");
    writeFileSync(file, solidPng(640, 480, [9, 9, 9]));
    const thumb = writeThumbnail(file);
    expect(thumb).toBe(path.join(dir, "shot.thumb.png"));
    expect(PNG.sync.read(readFileSync(thumb!)).width).toBe(THUMB_MAX_WIDTH);
  });

  it("returns null for non-PNG, missing or corrupt files", () => {
    const gif = path.join(dir, "a.gif");
    writeFileSync(gif, "GIF89a");
    const broken = path.join(dir, "broken.png");
    writeFileSync(broken, "not a png");
    expect(writeThumbnail(gif)).toBeNull();
    expect(writeThumbnail(path.join(dir, "missing.png"))).toBeNull();
    expect(writeThumbnail(broken)).toBeNull();
  });

  it("the store thumbnails screenshots on insert and backfills older rows", () => {
    const db = openVibeDb({ path: path.join(dir, "vibe.db") });
    migrateOwner(db, "verify");
    const board = createVibeStore(db);
    const verify = createVerifyStore(db, { root: dir });
    const project = board.projects.create({ name: "P", prefix: "THU", repoPath: dir, projectType: "web" });
    const card = board.cards.create({ projectId: project.id, title: "t", column: "todo" });
    const { verification } = verify.create({ cardId: card.id, projectId: project.id, commitHash: "abc", mode: "evidence", checks: [] });
    const file = path.join(dir, "ins.png");
    writeFileSync(file, solidPng(800, 600, [5, 6, 7]));
    const artifact = { kind: "screenshot" as const, path: file, capturedAt: "2026-10-19T00:00:00.000Z", commitHash: "abc", simulated: false };
    const added = verify.addEvidence(verification.id, null, artifact);
    expect(added.thumbPath).toBe(path.join(dir, "ins.thumb.png"));
    const plain = verify.addEvidence(verification.id, null, { ...artifact, kind: "log", path: path.join(dir, "x.log") });
    expect(plain.thumbPath).toBeNull();
    db.prepare("UPDATE evidence_file SET thumb_path = NULL WHERE id = ?").run(added.id);
    expect(verify.ensureThumb(verify.evidenceById(added.id)!)).toBe(path.join(dir, "ins.thumb.png"));
    expect(verify.evidenceById(added.id)!.thumbPath).toBe(path.join(dir, "ins.thumb.png"));
    db.close();
  });
});
