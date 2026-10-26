// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import type { VibeDb } from "./sqlite";

export interface TaskHandoffRow {
  workspaceId: string;
  tabNumber: number;
  agentId: string;
  /** Opaque to the shared layer; the owning plugin validates its shape. */
  packet: unknown;
  updatedAt: string;
}

/** One latest handoff packet per task tab. Not a milestone: it is overwritten every turn. */
export function createTaskHandoffCommands(db: VibeDb, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const decode = (row: {
    workspace_id: string;
    tab_number: number;
    agent_id: string;
    packet_json: string;
    updated_at: string;
  }): TaskHandoffRow => ({
    workspaceId: row.workspace_id,
    tabNumber: row.tab_number,
    agentId: row.agent_id,
    packet: JSON.parse(row.packet_json) as unknown,
    updatedAt: row.updated_at,
  });
  return {
    get(workspaceId: string, tabNumber: number): TaskHandoffRow | undefined {
      const row = db
        .prepare<Parameters<typeof decode>[0]>(
          "SELECT * FROM task_handoff WHERE workspace_id = ? AND tab_number = ?",
        )
        .get(workspaceId, tabNumber);
      return row ? decode(row) : undefined;
    },
    list(workspaceId: string): TaskHandoffRow[] {
      return db
        .prepare<Parameters<typeof decode>[0]>(
          "SELECT * FROM task_handoff WHERE workspace_id = ? ORDER BY tab_number",
        )
        .all(workspaceId)
        .map(decode);
    },
    save(workspaceId: string, tabNumber: number, agentId: string, packet: unknown): void {
      db.immediate(() => {
        db.prepare(
          `INSERT INTO task_handoff (workspace_id, tab_number, agent_id, packet_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, tab_number) DO UPDATE SET
             agent_id = excluded.agent_id, packet_json = excluded.packet_json,
             updated_at = excluded.updated_at`,
        ).run(workspaceId, tabNumber, agentId, JSON.stringify(packet), now().toISOString());
      });
    },
  };
}
export type TaskHandoffCommands = ReturnType<typeof createTaskHandoffCommands>;
