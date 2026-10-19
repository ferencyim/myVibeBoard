// "Verification result" service for the card UI (WP-21). vibe-verify owns the verification,
// verification_item and evidence_file tables; this module only reads them (plain SQL) from the
// shared vibe.db, serves evidence bytes, and queues the user's decisions:
//   approve -> verifying -> done through the board command layer (same call as vibe-verify's own),
//   reject / rerun -> a `verification.decision_requested` event that vibe-verify consumes.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  EvidenceFileSchema,
  VerificationItemSchema,
  VerificationSchema,
  type EvidenceFile,
  type Judgement,
} from "./vibe/contract";
import { decodeRow, decodeRows, publishEvent, resolveVibeHome, type VibeDb } from "./vibe/db";
import type { BoardService } from "./service";
import { BoardError } from "./service";
import type { VerificationDetail } from "../shared/rpc";

/** Evidence larger than this is not sent over RPC (videos: the UI shows the host path instead). */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

export const SUMMARY: Record<Judgement, string> = {
  pass: "All checks passed",
  doubt: "Some checks are doubtful",
  fail: "Some checks failed",
};

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

export function createVerifyService(options: { db: VibeDb; board: BoardService; home?: string }) {
  const { db, board } = options;
  const home = options.home ?? resolveVibeHome();

  /** vibe-verify creates its tables on first start; before that there is simply nothing to show. */
  const query = <T>(fn: () => T, empty: T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof Error && /no such table/i.test(error.message)) return empty;
      throw error;
    }
  };

  const cardOf = (ref: string) => board.cards.get(ref);

  function readNotes(verificationId: string): string[] {
    const file = path.join(home, "verify", "notes", `${verificationId}.json`);
    try {
      const notes: unknown = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(notes) ? notes.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  }

  function list(cardId: string) {
    return query(
      () =>
        decodeRows(
          VerificationSchema,
          db.prepare("SELECT * FROM verification WHERE card_id = ? ORDER BY started_at, id").all(cardId),
        ),
      [],
    );
  }

  function detailOf(id: string): VerificationDetail | null {
    return query(() => {
      const row = db.prepare("SELECT * FROM verification WHERE id = ?").get(id);
      if (!row) return null;
      const verification = decodeRow(VerificationSchema, row);
      return {
        verification,
        summary: verification.conclusion ? SUMMARY[verification.conclusion] : "Verification running",
        items: decodeRows(
          VerificationItemSchema,
          db.prepare("SELECT * FROM verification_item WHERE verification_id = ? ORDER BY position, id").all(id),
        ),
        evidence: decodeRows(
          EvidenceFileSchema,
          db.prepare("SELECT * FROM evidence_file WHERE verification_id = ? ORDER BY captured_at, id").all(id),
        ),
        notes: readNotes(id),
      };
    }, null);
  }

  function requireVerifying(ref: string) {
    const card = cardOf(ref);
    if (card.column !== "verifying") {
      throw new BoardError("conflict", `${card.key} is in "${card.column}", not verifying`);
    }
    return card;
  }

  function request(ref: string, action: "reject" | "rerun", comment?: string) {
    const card = requireVerifying(ref);
    publishEvent(db, {
      type: "verification.decision_requested",
      cardId: card.id,
      projectId: card.projectId,
      payload: { action, ...(comment ? { comment } : {}) },
      dedupeKey: `verify-decision:${card.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    });
  }

  return {
    get(ref: string, verificationId?: string): { detail: VerificationDetail | null } {
      const card = cardOf(ref);
      const id = verificationId ?? list(card.id).at(-1)?.id;
      return { detail: id ? detailOf(id) : null };
    },

    list: (ref: string) => ({ verifications: list(cardOf(ref).id) }),

    evidence(evidenceId: string, thumb?: boolean) {
      const evidence = query(() => {
        const row = db.prepare("SELECT * FROM evidence_file WHERE id = ?").get(evidenceId);
        return row ? decodeRow(EvidenceFileSchema, row) : null;
      }, null) as EvidenceFile | null;
      if (!evidence) throw new BoardError("not_found", `Evidence not found: ${evidenceId}`);
      const file = thumb && evidence.thumbPath && existsSync(evidence.thumbPath) ? evidence.thumbPath : evidence.path;
      let size: number;
      try {
        size = statSync(file).size;
      } catch {
        throw new BoardError("not_found", `Evidence file is gone: ${path.basename(file)}`);
      }
      if (size > MAX_EVIDENCE_BYTES) {
        throw new BoardError("too_large", `${path.basename(file)} is ${size} bytes; open it on the daemon host`);
      }
      return {
        evidence,
        mimeType: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        base64: readFileSync(file).toString("base64"),
      };
    },

    approve(ref: string) {
      const card = requireVerifying(ref);
      board.cards.move(card.id, { to: "done", actor: "user", reason: "verification accepted" });
      return { ok: true as const };
    },

    reject(ref: string, comment: string) {
      request(ref, "reject", comment);
      return { ok: true as const };
    },

    rerun(ref: string) {
      request(ref, "rerun");
      return { queued: true as const };
    },
  };
}

export type VerifyService = ReturnType<typeof createVerifyService>;
