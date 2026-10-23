// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { VibeDb } from "./sqlite";

export interface UsageEventInput {
  ts: string;
  provider: string;
  model: string;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  durationMs: number | null;
  cost: number | null;
  dedupeKey: string;
}

export interface UsageSessionLink {
  provider: string;
  sessionId: string;
  projectId: string | null;
  workspaceId: string | null;
  role: string | null;
  agentId: string | null;
}

/** Usage writes share the database transaction boundary; replays never add a second event. */
export function createUsageCommands(db: VibeDb) {
  const event = db.prepare(
    `INSERT INTO usage_event (ts, provider, model, session_id, tokens_in, tokens_out,
       tokens_cache_read, tokens_cache_write, duration_ms, cost, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       duration_ms = CASE WHEN excluded.duration_ms > COALESCE(usage_event.duration_ms, 0)
         THEN excluded.duration_ms ELSE usage_event.duration_ms END,
       cost = COALESCE(usage_event.cost, excluded.cost)`,
  );
  const cursor = db.prepare(
    `INSERT INTO usage_cursor (file_path, byte_offset, size_bytes, mtime_ms, updated_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET
       byte_offset = excluded.byte_offset, size_bytes = excluded.size_bytes,
       mtime_ms = excluded.mtime_ms, updated_at = excluded.updated_at`,
  );
  const link = db.prepare(
    `UPDATE usage_event SET project_id = COALESCE(project_id, ?),
       workspace_id = COALESCE(workspace_id, ?), role = COALESCE(role, ?),
       agent_id = COALESCE(agent_id, ?)
     WHERE provider = ? AND session_id = ? AND (
       (project_id IS NULL AND ? IS NOT NULL) OR (workspace_id IS NULL AND ? IS NOT NULL)
       OR (role IS NULL AND ? IS NOT NULL) OR (agent_id IS NULL AND ? IS NOT NULL))`,
  );
  return {
    putEvent(input: UsageEventInput): void {
      db.immediate(() =>
        event.run(
          input.ts,
          input.provider,
          input.model,
          input.sessionId,
          input.tokensIn,
          input.tokensOut,
          input.tokensCacheRead,
          input.tokensCacheWrite,
          input.durationMs,
          input.cost,
          input.dedupeKey,
        ),
      );
    },
    putCursor(input: {
      filePath: string;
      byteOffset: number;
      sizeBytes: number;
      mtimeMs: number;
      updatedAt: string;
    }): void {
      db.immediate(() =>
        cursor.run(
          input.filePath,
          input.byteOffset,
          input.sizeBytes,
          input.mtimeMs,
          input.updatedAt,
        ),
      );
    },
    resetCursors(): void {
      db.immediate(() => db.exec("DELETE FROM usage_cursor"));
    },
    relink(links: readonly UsageSessionLink[]): number {
      return db.immediate(() => {
        let changed = 0;
        for (const item of links) {
          changed += link.run(
            item.projectId,
            item.workspaceId,
            item.role,
            item.agentId,
            item.provider,
            item.sessionId,
            item.projectId,
            item.workspaceId,
            item.role,
            item.agentId,
          ).changes;
        }
        return changed;
      });
    },
  };
}
