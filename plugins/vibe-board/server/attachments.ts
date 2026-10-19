import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { MAX_ATTACHMENT_SIZE_BYTES } from "../shared/constants";
import { tasksDataDir } from "./sqlite";
import type { TasksStore } from "./store";
import type { Attachment } from "./types";

const INLINE_RASTER_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const RASTER_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
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
};

const MIME_PATTERN =
  /^(application|audio|font|image|message|model|multipart|text|video)\/[!#$&^_.+\-A-Za-z0-9]+$/;

const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export type AttachmentOwner =
  | { taskId: string; commentId?: never }
  | { taskId?: never; commentId: string };

export class AttachmentReferencedError extends Error {
  constructor(readonly attachment: Attachment) {
    super(
      `Attachment "${attachment.fileName}" is used in the task description. Remove it from the description before deleting the attachment.`,
    );
    this.name = "AttachmentReferencedError";
  }
}

export function attachmentDownloadUrl(attachmentId: string): string {
  return `paseotask://attachments/${encodeURIComponent(attachmentId)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeAttachmentDescriptionReferences(
  markdown: string,
  attachmentId: string,
): string {
  const url = escapeRegExp(attachmentDownloadUrl(attachmentId));
  return markdown.replace(new RegExp(`!\\[[^\\]]*\\]\\(${url}\\)`, "g"), "");
}

function pathInside(root: string, blobPath: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, blobPath);
  if (
    absolutePath !== absoluteRoot &&
    !absolutePath.startsWith(`${absoluteRoot}${sep}`)
  ) {
    throw new Error("Attachment blob path escapes the plugin data directory");
  }
  return absolutePath;
}

function sanitizeFileName(fileName: string): string {
  const baseName = fileName
    .normalize("NFC")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.trim();
  let sanitized = (baseName ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(BIDI_CONTROL_PATTERN, "_")
    .replace(/^\.+/, "")
    .trim();
  while (Buffer.byteLength(sanitized, "utf8") > 180) {
    sanitized = sanitized.slice(0, -1);
  }
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "attachment";
  }
  return sanitized;
}

function normalizeMime(mime: string): string {
  const normalized = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!MIME_PATTERN.test(normalized)) {
    return "application/octet-stream";
  }
  return normalized;
}

function isInlineRasterMime(mime: string): boolean {
  return INLINE_RASTER_MIMES.has(
    mime.split(";", 1)[0]?.trim().toLowerCase() ?? "",
  );
}

function bytesMatch(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function sniffRasterMime(bytes: Uint8Array): string | undefined {
  if (bytesMatch(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (bytesMatch(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    bytesMatch(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    bytesMatch(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    bytesMatch(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    bytesMatch(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (
    bytesMatch(bytes, 4, [0x66, 0x74, 0x79, 0x70]) &&
    (bytesMatch(bytes, 8, [0x61, 0x76, 0x69, 0x66]) ||
      bytesMatch(bytes, 8, [0x61, 0x76, 0x69, 0x73]))
  ) {
    return "image/avif";
  }
  return undefined;
}

function inferMimeFromBytes(bytes: Uint8Array, fileName: string): string {
  const sniffed = sniffRasterMime(bytes.subarray(0, 12));
  if (sniffed) return sniffed;
  const extension = fileName.toLowerCase().match(/\.[^.]+$/u)?.[0];
  return (
    (extension && RASTER_MIME_BY_EXTENSION[extension]) ??
    "application/octet-stream"
  );
}

function normalizeOwner(
  taskId: string | null | undefined,
  commentId: string | null | undefined,
): AttachmentOwner {
  const normalizedTaskId = taskId?.trim() || undefined;
  const normalizedCommentId = commentId?.trim() || undefined;
  if (Boolean(normalizedTaskId) === Boolean(normalizedCommentId)) {
    throw new Error("exactly one of taskId or commentId is required");
  }
  if (normalizedTaskId) return { taskId: normalizedTaskId };
  if (normalizedCommentId) return { commentId: normalizedCommentId };
  throw new Error("unreachable attachment owner state");
}

export async function removeAttachmentBlobs(
  storeRoot: string,
  attachments: readonly Pick<Attachment, "id" | "blobPath">[],
): Promise<void> {
  if (attachments.length === 0) return;
  await Promise.allSettled(
    attachments.map(async (attachment) => {
      const absolutePath = pathInside(storeRoot, attachment.blobPath);
      await rm(dirname(absolutePath), { recursive: true, force: true });
    }),
  );
}

export async function saveAttachmentFromBytes(
  store: TasksStore,
  bytes: Uint8Array,
  options: {
    taskId?: string | null;
    commentId?: string | null;
    fileName: string;
    mime?: string;
    rootDir?: string;
  },
): Promise<Attachment> {
  if (bytes.byteLength > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error("attachment exceeds the 25 MB limit");
  }
  const root = options.rootDir ?? tasksDataDir();
  const owner = normalizeOwner(options.taskId, options.commentId);
  const safeFileName = sanitizeFileName(options.fileName);
  const safeMime = normalizeMime(
    options.mime ?? inferMimeFromBytes(bytes, options.fileName),
  );
  const attachment = store.createAttachment({
    ...owner,
    fileName: safeFileName,
    mime: safeMime,
    sizeBytes: bytes.byteLength,
    blobPath: join("blobs", "pending", safeFileName),
    isImage: isInlineRasterMime(safeMime),
  });
  const blobPath = join("blobs", attachment.id, safeFileName);
  const absolutePath = pathInside(root, blobPath);

  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    return store.updateAttachment(attachment.id, { blobPath });
  } catch (error) {
    store.deleteAttachment(attachment.id);
    await rm(dirname(absolutePath), { recursive: true, force: true });
    throw error;
  }
}

export async function readAttachmentContent(
  store: TasksStore,
  attachmentId: string,
  rootDir = tasksDataDir(),
): Promise<{ attachment: Attachment; content: Buffer }> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`);
  const sourcePath = pathInside(rootDir, attachment.blobPath);
  return { attachment, content: await readFile(sourcePath) };
}

export async function deleteAttachmentById(
  store: TasksStore,
  attachmentId: string,
  options: {
    rootDir?: string;
    removeDescriptionReferences?: boolean;
  } = {},
): Promise<Attachment | null> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) return null;
  const rootDir = options.rootDir ?? tasksDataDir();

  const taskId =
    attachment.taskId ??
    (attachment.commentId
      ? store.getComment(attachment.commentId)?.taskId
      : undefined);
  const ownerTask = taskId ? store.getTask(taskId) : undefined;
  let nextDescription: string | undefined;
  if (ownerTask?.description.includes(attachmentDownloadUrl(attachment.id))) {
    if (!options.removeDescriptionReferences) {
      throw new AttachmentReferencedError(attachment);
    }
    nextDescription = removeAttachmentDescriptionReferences(
      ownerTask.description,
      attachment.id,
    );
    if (nextDescription === ownerTask.description) {
      throw new AttachmentReferencedError(attachment);
    }
  }

  await removeAttachmentBlobs(rootDir, [attachment]);
  if (ownerTask && nextDescription !== undefined) {
    store.updateTask(ownerTask.id, { description: nextDescription });
  }
  if (!store.deleteAttachment(attachment.id)) return null;
  return attachment;
}
