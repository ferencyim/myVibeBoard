// Task evidence writes use the shared transaction boundary; no legacy card is created.
import {
  TaskVerificationSchema,
  VerificationItemSchema,
  EvidenceFileSchema,
  newId,
  type EvidenceArtifact,
  type Judgement,
} from "../contract";
import { decodeRow, decodeRows } from "./rows";
import { publishEvent } from "./events";
import type { VibeDb } from "./sqlite";

export function createTaskVerificationCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const commands = {
    get(id: string) {
      const row = db
        .prepare("SELECT * FROM verification WHERE id = ? AND workspace_id IS NOT NULL")
        .get(id);
      return row ? decodeRow(TaskVerificationSchema, row) : undefined;
    },
    list(workspaceId: string, confirmedAt?: string) {
      return decodeRows(
        TaskVerificationSchema,
        confirmedAt
          ? db
              .prepare(
                "SELECT * FROM verification WHERE workspace_id = ? AND confirmed_at = ? ORDER BY started_at,id",
              )
              .all(workspaceId, confirmedAt)
          : db
              .prepare("SELECT * FROM verification WHERE workspace_id = ? ORDER BY started_at,id")
              .all(workspaceId),
      );
    },
    running() {
      return decodeRows(
        TaskVerificationSchema,
        db
          .prepare(
            "SELECT * FROM verification WHERE workspace_id IS NOT NULL AND finished_at IS NULL",
          )
          .all(),
      );
    },
    create(input: {
      workspaceId: string;
      confirmedAt: string;
      projectId: string;
      commitHash: string;
      checks: Array<{ text: string; method: string }>;
    }) {
      return db.immediate(() => {
        const task = db
          .prepare<{ confirmed_at: string | null }>(
            "SELECT confirmed_at FROM task WHERE workspace_id = ?",
          )
          .get(input.workspaceId);
        if (!task || task.confirmed_at !== input.confirmedAt)
          throw new Error("任务确认已变化，拒绝保存验证");
        const id = newId(now().getTime());
        db.prepare(
          "INSERT INTO verification (id,card_id,workspace_id,confirmed_at,project_id,commit_hash,mode,started_at) VALUES (?,NULL,?,?,?,?, 'evidence',?)",
        ).run(id, input.workspaceId, input.confirmedAt, input.projectId, input.commitHash, iso());
        const items = input.checks.map((c) => commands.addItem(id, c));
        publishEvent(
          db,
          {
            type: "verification.started",
            projectId: input.projectId,
            payload: {
              verificationId: id,
              workspaceId: input.workspaceId,
              confirmedAt: input.confirmedAt,
            },
          },
          now,
        );
        return { verification: commands.get(id)!, items };
      });
    },
    items(id: string) {
      return decodeRows(
        VerificationItemSchema,
        db
          .prepare("SELECT * FROM verification_item WHERE verification_id = ? ORDER BY position,id")
          .all(id),
      );
    },
    evidence(id: string) {
      return decodeRows(
        EvidenceFileSchema,
        db
          .prepare("SELECT * FROM evidence_file WHERE verification_id = ? ORDER BY captured_at,id")
          .all(id),
      );
    },
    evidenceById(id: string) {
      const row = db.prepare("SELECT * FROM evidence_file WHERE id = ?").get(id);
      return row ? decodeRow(EvidenceFileSchema, row) : undefined;
    },
    setVerifier(id: string, agentId: string) {
      db.immediate(() => {
        if (!commands.get(id)) throw new Error("任务验证不存在");
        db.prepare("UPDATE verification SET verifier_agent_id = ? WHERE id = ?").run(agentId, id);
      });
    },
    addItem(id: string, check: { text: string; method: string; kind?: "check" | "review" }) {
      return db.immediate(() => {
        if (!commands.get(id)) throw new Error("任务验证不存在");
        const itemId = newId(now().getTime());
        const position = commands.items(id).length;
        db.prepare(
          "INSERT INTO verification_item (id,verification_id,kind,position,check_text,method) VALUES (?,?,?,?,?,?)",
        ).run(itemId, id, check.kind ?? "check", position, check.text, check.method);
        return commands.items(id).find((i) => i.id === itemId)!;
      });
    },
    judgeItem(itemId: string, judgement: Judgement, note: string, evidenceIds: string[] = []) {
      db.immediate(() => {
        db.prepare(
          "UPDATE verification_item SET judgement = ?,note = ?,evidence_ids_json = ? WHERE id = ? AND verification_id IN (SELECT id FROM verification WHERE workspace_id IS NOT NULL)",
        ).run(judgement, note, JSON.stringify(evidenceIds), itemId);
      });
    },
    addEvidence(id: string, itemId: string | null, artifact: EvidenceArtifact) {
      return db.immediate(() => {
        if (!commands.get(id)) throw new Error("任务验证不存在");
        const fileId = newId(now().getTime());
        db.prepare(
          "INSERT INTO evidence_file (id,verification_id,item_id,kind,path,thumb_path,sha256,captured_at,commit_hash,simulated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ).run(
          fileId,
          id,
          itemId,
          artifact.kind,
          artifact.path,
          artifact.thumbPath ?? null,
          artifact.sha256 ?? "",
          artifact.capturedAt,
          artifact.commitHash,
          artifact.simulated ? 1 : 0,
        );
        return commands.evidenceById(fileId)!;
      });
    },
    finish(id: string, conclusion: Judgement) {
      db.immediate(() => {
        const v = commands.get(id);
        if (!v || v.finishedAt) return;
        db.prepare("UPDATE verification SET conclusion = ?,finished_at = ? WHERE id = ?").run(
          conclusion,
          iso(),
          id,
        );
        publishEvent(
          db,
          {
            type: "verification.finished",
            projectId: v.projectId,
            payload: {
              verificationId: id,
              conclusion,
              workspaceId: v.workspaceId,
              confirmedAt: v.confirmedAt,
            },
          },
          now,
        );
      });
    },
  };
  return commands;
}
export type TaskVerificationCommands = ReturnType<typeof createTaskVerificationCommands>;
