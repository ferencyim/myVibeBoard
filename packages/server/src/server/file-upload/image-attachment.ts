import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

/** Durable inline images share the upload store's file/reference contract. */
export function persistImageAttachment(
  paseoHome: string,
  image: { data: string; mimeType: string },
): Extract<AgentAttachment, { type: "uploaded_file" }> {
  const bytes = Buffer.from(image.data.replace(/^data:[^;]+;base64,/, ""), "base64");
  const id = `image_${createHash("sha256").update(bytes).digest("hex")}`;
  const directory = join(paseoHome, "uploads", id);
  const fileName = "image";
  const filePath = join(directory, fileName);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return {
    type: "uploaded_file",
    id,
    fileName,
    path: filePath,
    mimeType: image.mimeType,
    size: bytes.length,
  };
}
