// RPC handlers behind shared/rpc.ts, used by the "verification result" block of the board UI.

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/rpc";
import type { VerifyStore } from "./store";
import type { VibeStore } from "./vibe/db";

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
    board: VibeStore;
    evidenceRoot?: string;
    verify: VerifyStore;
  },
): void {
  const { board, verify } = deps;
  const card = (ref: string) => board.cards.get(ref) ?? fail("not_found", `Card not found: ${ref}`);

  server.handle(rpc.verifyGetRpc, ({ card: ref, verificationId }) => {
    const c = card(ref);
    const id = verificationId ?? verify.latest(c.id)?.id;
    return { detail: (id && verify.detail(id)) || null };
  });

  server.handle(rpc.verifyListRpc, ({ card: ref }) => ({
    verifications: verify.list(card(ref).id),
  }));

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

  const retired = () =>
    fail("unavailable", "旧看板验证操作已停用，请在原生任务对话中继续；旧卡片不会自动恢复或运行。");
  server.handle(rpc.verifyApproveRpc, retired);
  server.handle(rpc.verifyRejectRpc, retired);
  server.handle(rpc.verifyRerunRpc, retired);
}
