// RPC handlers behind shared/rpc.ts, used by the "verification result" block of the board UI.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/rpc";
import type { Pipeline } from "./pipeline";
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

export function registerVerifyRpcs(
  server: PluginServerContext,
  deps: {
    board: VibeStore;
    verify: VerifyStore;
    pipeline: Pipeline;
    rerun: (cardId: string) => void;
  },
): void {
  const { board, verify, pipeline } = deps;
  const card = (ref: string) => board.cards.get(ref) ?? fail("not_found", `Card not found: ${ref}`);

  server.handle(rpc.verifyGetRpc, ({ card: ref, verificationId }) => {
    const c = card(ref);
    const id = verificationId ?? verify.latest(c.id)?.id;
    return { detail: (id && verify.detail(id)) || null };
  });

  server.handle(rpc.verifyListRpc, ({ card: ref }) => ({ verifications: verify.list(card(ref).id) }));

  server.handle(rpc.verifyEvidenceRpc, ({ evidenceId, thumb }) => {
    const evidence = verify.evidenceById(evidenceId) ?? fail("not_found", `Evidence not found: ${evidenceId}`);
    const file = thumb && evidence.thumbPath ? evidence.thumbPath : evidence.path;
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      return fail("not_found", `Evidence file is gone: ${path.basename(file)}`);
    }
    return {
      evidence,
      mimeType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      base64: bytes.toString("base64"),
    };
  });

  server.handle(rpc.verifyApproveRpc, ({ card: ref }) => {
    const c = card(ref);
    if (c.column !== "verifying") fail("conflict", `${c.key} is in "${c.column}", not verifying`);
    pipeline.approve(c.id);
    return { ok: true as const };
  });

  server.handle(rpc.verifyRejectRpc, async ({ card: ref, comment }) => {
    const c = card(ref);
    if (c.column !== "verifying") fail("conflict", `${c.key} is in "${c.column}", not verifying`);
    return { ok: true as const, notifiedWorker: await pipeline.reject(c.id, comment) };
  });

  server.handle(rpc.verifyRerunRpc, ({ card: ref }) => {
    const c = card(ref);
    if (c.column !== "verifying") fail("conflict", `${c.key} is in "${c.column}", not verifying`);
    if (pipeline.isRunning(c.id)) return { started: false };
    deps.rerun(c.id);
    return { started: true };
  });
}
