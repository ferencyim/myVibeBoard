// Evidence bytes for the native task verification panel.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/rpc";
import type { TaskVerifyStore } from "./task-store";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
};

const fail = (code: string, message: string): never => {
  throw new Error(`[${code}] ${message}`);
};

function validateEvidencePath(file: string, root?: string): void {
  if (!root) return;
  const relative = path.relative(realpathSync(root), realpathSync(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("证据文件不在允许目录内");
}
export function readEvidenceBytes(file: string, root?: string): Buffer {
  validateEvidencePath(file, root);
  return readFileSync(file);
}

export function registerVerifyRpcs(
  server: PluginServerContext,
  deps: {
    evidenceRoot?: string;
    verify: TaskVerifyStore;
  },
): void {
  const { verify } = deps;

  server.handle(rpc.verifyEvidenceRpc, ({ evidenceId, thumb }) => {
    const evidence =
      verify.evidenceById(evidenceId) ?? fail("not_found", `Evidence not found: ${evidenceId}`);
    validateEvidencePath(evidence.path, deps.evidenceRoot);
    const file = (thumb && verify.ensureThumb(evidence)) || evidence.path;
    let bytes: Buffer;
    try {
      bytes = readEvidenceBytes(file, deps.evidenceRoot);
    } catch {
      return fail("not_found", `Evidence file is gone: ${path.basename(file)}`);
    }
    return {
      evidence,
      mimeType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      base64: bytes.toString("base64"),
    };
  });
}
