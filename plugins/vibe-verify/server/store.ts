// Verify-owned tables (verification, verification_item, evidence_file). Only this plugin writes
// them, so plain SQL is fine here; events go out through publishEvent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  EvidenceFileSchema,
  VerificationItemSchema,
  VerificationSchema,
  newId,
  type EvidenceArtifact,
  type EvidenceFile,
  type Judgement,
  type Verification,
  type VerificationItem,
  type VerificationMode,
} from "./vibe/contract";
import { decodeRow, decodeRows, publishEvent, type VibeDb } from "./vibe/db";
import { writeThumbnail } from "./thumbnail";
import type { VerificationDetail } from "../shared/rpc";

export const SUMMARY: Record<Judgement, string> = {
  pass: "All checks passed",
  doubt: "Some checks are doubtful",
  fail: "Some checks failed",
};

/** fail beats doubt beats pass; an unjudged item counts as doubt. */
export function aggregate(judgements: ReadonlyArray<Judgement | null>): Judgement {
  if (judgements.includes("fail")) return "fail";
  if (judgements.length === 0 || judgements.some((j) => j === null || j === "doubt")) return "doubt";
  return "pass";
}

export interface VerifyStore {
  create(input: {
    cardId: string;
    projectId: string;
    commitHash: string;
    mode: VerificationMode;
    checks: Array<{ text: string; method: string }>;
  }): { verification: Verification; items: VerificationItem[] };
  get(id: string): Verification | undefined;
  latest(cardId: string): Verification | undefined;
  list(cardId: string): Verification[];
  running(): Verification[];
  items(verificationId: string): VerificationItem[];
  evidence(verificationId: string): EvidenceFile[];
  evidenceById(id: string): EvidenceFile | undefined;
  /** Creates and records the thumbnail of an image evidence file that has none; returns its path. */
  ensureThumb(evidence: EvidenceFile): string | null;
  setVerifier(verificationId: string, agentId: string): void;
  addItem(
    verificationId: string,
    check: { text: string; method: string; kind?: "check" | "review" },
  ): VerificationItem;
  judgeItem(itemId: string, judgement: Judgement, note: string, evidenceIds?: string[]): void;
  addEvidence(verificationId: string, itemId: string | null, artifact: EvidenceArtifact): EvidenceFile;
  finish(verificationId: string, conclusion: Judgement, projectId: string | null): void;
  writeNotes(verificationId: string, notes: string[]): void;
  detail(verificationId: string): VerificationDetail | undefined;
  /** Directory the evidence of one verification is written into. */
  dirFor(verificationId: string, cardKey: string): string;
}

export function createVerifyStore(
  db: VibeDb,
  options: { root: string; now?: () => Date },
): VerifyStore {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const notesFile = (id: string) => path.join(options.root, "notes", `${id}.json`);

  const store: VerifyStore = {
    create(input) {
      const id = newId(now().getTime());
      return db.immediate(() => {
        db.prepare(
          `INSERT INTO verification (id, card_id, commit_hash, conclusion, verifier_agent_id, mode, started_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
        ).run(id, input.cardId, input.commitHash, input.mode, iso());
        const items = input.checks.map((c) => store.addItem(id, c));
        publishEvent(
          db,
          {
            type: "verification.started",
            cardId: input.cardId,
            projectId: input.projectId,
            payload: { verificationId: id },
          },
          now,
        );
        return { verification: store.get(id)!, items };
      });
    },
    get: (id) => {
      const row = db.prepare("SELECT * FROM verification WHERE id = ?").get(id);
      return row ? decodeRow(VerificationSchema, row) : undefined;
    },
    latest: (cardId) => store.list(cardId).at(-1),
    list: (cardId) =>
      decodeRows(
        VerificationSchema,
        db
          .prepare("SELECT * FROM verification WHERE card_id = ? ORDER BY started_at, id")
          .all(cardId),
      ),
    running: () =>
      decodeRows(
        VerificationSchema,
        db.prepare("SELECT * FROM verification WHERE finished_at IS NULL").all(),
      ),
    items: (verificationId) =>
      decodeRows(
        VerificationItemSchema,
        db
          .prepare("SELECT * FROM verification_item WHERE verification_id = ? ORDER BY position, id")
          .all(verificationId),
      ),
    evidence: (verificationId) =>
      decodeRows(
        EvidenceFileSchema,
        db
          .prepare("SELECT * FROM evidence_file WHERE verification_id = ? ORDER BY captured_at, id")
          .all(verificationId),
      ),
    evidenceById: (id) => {
      const row = db.prepare("SELECT * FROM evidence_file WHERE id = ?").get(id);
      return row ? decodeRow(EvidenceFileSchema, row) : undefined;
    },
    ensureThumb(evidence) {
      if (evidence.thumbPath) return evidence.thumbPath;
      const thumbPath = writeThumbnail(evidence.path);
      if (thumbPath) db.prepare("UPDATE evidence_file SET thumb_path = ? WHERE id = ?").run(thumbPath, evidence.id);
      return thumbPath;
    },
    setVerifier(verificationId, agentId) {
      db.prepare("UPDATE verification SET verifier_agent_id = ? WHERE id = ?").run(agentId, verificationId);
    },
    addItem(verificationId, check) {
      const id = newId(now().getTime());
      const position =
        db
          .prepare<{ n: number }>(
            "SELECT COUNT(*) AS n FROM verification_item WHERE verification_id = ?",
          )
          .get(verificationId)?.n ?? 0;
      db.prepare(
        `INSERT INTO verification_item (id, verification_id, kind, position, check_text, method) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, verificationId, check.kind ?? "check", position, check.text, check.method);
      return decodeRow(
        VerificationItemSchema,
        db.prepare("SELECT * FROM verification_item WHERE id = ?").get(id)!,
      );
    },
    judgeItem(itemId, judgement, note, evidenceIds) {
      db.prepare(
        `UPDATE verification_item SET judgement = ?, note = ?,
           evidence_ids_json = COALESCE(?, evidence_ids_json) WHERE id = ?`,
      ).run(judgement, note, evidenceIds ? JSON.stringify(evidenceIds) : null, itemId);
    },
    addEvidence(verificationId, itemId, artifact) {
      const id = newId(now().getTime());
      db.prepare(
        `INSERT INTO evidence_file (id, verification_id, item_id, kind, path, thumb_path, sha256, captured_at, commit_hash, simulated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        verificationId,
        itemId,
        artifact.kind,
        artifact.path,
        artifact.thumbPath ?? (artifact.kind === "screenshot" ? writeThumbnail(artifact.path) : null),
        artifact.sha256 ?? "",
        artifact.capturedAt,
        artifact.commitHash,
        artifact.simulated ? 1 : 0,
      );
      return store.evidenceById(id)!;
    },
    finish(verificationId, conclusion, projectId) {
      const v = store.get(verificationId);
      if (!v) return;
      db.immediate(() => {
        db.prepare("UPDATE verification SET conclusion = ?, finished_at = ? WHERE id = ?").run(
          conclusion,
          iso(),
          verificationId,
        );
        publishEvent(
          db,
          {
            type: "verification.finished",
            cardId: v.cardId,
            projectId,
            payload: { verificationId, conclusion },
          },
          now,
        );
      });
    },
    writeNotes(verificationId, notes) {
      const file = notesFile(verificationId);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(notes, null, 2));
    },
    detail(verificationId) {
      const verification = store.get(verificationId);
      if (!verification) return undefined;
      let notes: string[] = [];
      if (existsSync(notesFile(verificationId))) {
        try {
          notes = JSON.parse(readFileSync(notesFile(verificationId), "utf8")) as string[];
        } catch {
          notes = [];
        }
      }
      return {
        verification,
        summary: verification.conclusion ? SUMMARY[verification.conclusion] : "Verification running",
        items: store.items(verificationId),
        evidence: store.evidence(verificationId),
        notes,
      };
    },
    dirFor: (verificationId, cardKey) => path.join(options.root, cardKey, verificationId),
  };
  return store;
}
