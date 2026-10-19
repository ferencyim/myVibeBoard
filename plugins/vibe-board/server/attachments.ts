// Card attachments (reference images, files). Rows live in the shared vibe.db `attachment`
// table, blob included (owner: core). The table is not syncable, so plain SQL is fine here.

import { createHash } from "node:crypto";
import { AttachmentSchema, newId, type Attachment } from "./vibe/contract";
import { decodeRow, decodeRows, type VibeDb } from "./vibe/db";
import { MAX_ATTACHMENT_SIZE_BYTES } from "../shared/rpc";

const BIDI_CONTROL_PATTERN = /[؜‎‏‪-‮⁦-⁩]/g;
const MIME_PATTERN =
  /^(application|audio|font|image|message|model|multipart|text|video)\/[!#$&^_.+\-A-Za-z0-9]+$/;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".log": "text/plain",
};

const COLUMNS = "id, card_id, card_event_id, filename, mime_type, size_bytes, sha256, created_at";

export class AttachmentError extends Error {
  constructor(
    readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export function sanitizeFileName(fileName: string): string {
  const baseName = fileName.normalize("NFC").replaceAll("\\", "/").split("/").at(-1)?.trim();
  let sanitized = (baseName ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(BIDI_CONTROL_PATTERN, "_")
    .replace(/^\.+/, "")
    .trim();
  while (Buffer.byteLength(sanitized, "utf8") > 180) sanitized = sanitized.slice(0, -1);
  return !sanitized || sanitized === "." || sanitized === ".." ? "attachment" : sanitized;
}

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, 8, [0x57, 0x45, 0x42, 0x50]))
    return "image/webp";
  if (startsWith(bytes, 4, [0x66, 0x74, 0x79, 0x70]) && startsWith(bytes, 8, [0x61, 0x76, 0x69]))
    return "image/avif";
  return undefined;
}

function resolveMime(bytes: Uint8Array, fileName: string, declared?: string): string {
  const sniffed = sniffImageMime(bytes.subarray(0, 12));
  if (sniffed) return sniffed;
  const normalized = declared?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (MIME_PATTERN.test(normalized)) return normalized;
  const extension = fileName.toLowerCase().match(/\.[^.]+$/u)?.[0];
  return (extension && MIME_BY_EXTENSION[extension]) || "application/octet-stream";
}

export function createAttachments(db: VibeDb, now: () => Date = () => new Date()) {
  return {
    list(cardId: string): Attachment[] {
      return decodeRows(
        AttachmentSchema,
        db
          .prepare(`SELECT ${COLUMNS} FROM attachment WHERE card_id = ? ORDER BY created_at, id`)
          .all(cardId),
      );
    },
    get(id: string): Attachment | undefined {
      const row = db.prepare(`SELECT ${COLUMNS} FROM attachment WHERE id = ?`).get(id);
      return row ? decodeRow(AttachmentSchema, row) : undefined;
    },
    create(
      cardId: string,
      bytes: Uint8Array,
      options: { fileName: string; mime?: string; cardEventId?: string | null },
    ): Attachment {
      if (bytes.byteLength === 0) throw new AttachmentError("invalid", "attachment is empty");
      if (bytes.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
        throw new AttachmentError("invalid", "attachment exceeds the 25 MB limit");
      }
      const fileName = sanitizeFileName(options.fileName);
      const id = newId(now().getTime());
      db.prepare(
        `INSERT INTO attachment (id, card_id, card_event_id, filename, mime_type, size_bytes, sha256, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        cardId,
        options.cardEventId ?? null,
        fileName,
        resolveMime(bytes, fileName, options.mime),
        bytes.byteLength,
        createHash("sha256").update(bytes).digest("hex"),
        bytes,
        now().toISOString(),
      );
      return this.get(id) as Attachment;
    },
    read(id: string): { attachment: Attachment; content: Buffer } {
      const attachment = this.get(id);
      if (!attachment) throw new AttachmentError("not_found", `Attachment not found: ${id}`);
      const row = db.prepare<{ data: Uint8Array }>("SELECT data FROM attachment WHERE id = ?").get(id);
      return { attachment, content: Buffer.from(row?.data ?? new Uint8Array()) };
    },
    delete(id: string): boolean {
      return db.prepare("DELETE FROM attachment WHERE id = ?").run(id).changes > 0;
    },
  };
}

export type Attachments = ReturnType<typeof createAttachments>;
