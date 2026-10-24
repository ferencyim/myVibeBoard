import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { EvidenceFileSchema, type EvidenceFile } from "./vibe/contract";
import { decodeRow, type VibeDb } from "./vibe/db";
import { BoardError } from "./service";
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
};

export function createTaskEvidenceReader(db: VibeDb) {
  const query = <T>(fn: () => T, empty: T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof Error && /no such table/i.test(error.message)) return empty;
      throw error;
    }
  };
  return {
    evidence(evidenceId: string, thumb?: boolean) {
      const evidence = query(() => {
        const row = db.prepare("SELECT * FROM evidence_file WHERE id = ?").get(evidenceId);
        return row ? decodeRow(EvidenceFileSchema, row) : null;
      }, null) as EvidenceFile | null;
      if (!evidence) throw new BoardError("not_found", `找不到证据：${evidenceId}`);
      const file =
        thumb && evidence.thumbPath && existsSync(evidence.thumbPath)
          ? evidence.thumbPath
          : evidence.path;
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        throw new BoardError("not_found", `证据文件已不存在：${path.basename(file)}`);
      }
      if (size > MAX_EVIDENCE_BYTES) {
        throw new BoardError(
          "too_large",
          `${path.basename(file)} 有 ${size} 字节，太大了，请在守护进程所在的机器上打开`,
        );
      }
      return {
        evidence,
        mimeType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        base64: readFileSync(file).toString("base64"),
      };
    },
  };
}
