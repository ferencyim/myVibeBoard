import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTaskEvidenceReader } from "../server/evidence";
import type { VibeDb } from "../server/vibe/db";

it("异步读取证据，缩略图缺失时回退原图，并拒绝过大文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-evidence-"));
  try {
    const file = join(dir, "evidence.txt");
    await writeFile(file, "证据");
    const row = {
      id: "e", verification_id: "v", item_id: null, kind: "log", path: file,
      thumb_path: join(dir, "missing.png"), sha256: "hash", captured_at: "2026-01-01T00:00:00.000Z",
      commit_hash: "commit", simulated: 0,
    };
    const db = { prepare: () => ({ get: () => row }) } as unknown as VibeDb;
    const reader = createTaskEvidenceReader(db);
    expect(await reader.evidence("e", true)).toMatchObject({
      mimeType: "text/plain", base64: Buffer.from("证据").toString("base64"),
    });
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(reader.evidence("e")).rejects.toThrow("太大了");
    await rm(file);
    await expect(reader.evidence("e")).rejects.toThrow("证据文件已不存在");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
