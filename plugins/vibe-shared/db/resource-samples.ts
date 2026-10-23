import type { VibeDb } from "./sqlite";

export interface ResourceSampleInput {
  ts: string;
  cpu: number;
  mem: number;
  perSession: Record<string, unknown>;
  devicePool: Record<string, unknown>;
}

/** Resource telemetry writes use the same command boundary as other shared database owners. */
export function createResourceSampleCommands(db: VibeDb) {
  return {
    record(input: ResourceSampleInput): number {
      return db.immediate(() =>
        Number(
          db
            .prepare(
              "INSERT INTO resource_sample (ts,cpu,mem,per_session_json,device_pool_json) VALUES (?,?,?,?,?)",
            )
            .run(
              input.ts,
              input.cpu,
              input.mem,
              JSON.stringify(input.perSession),
              JSON.stringify(input.devicePool),
            ).lastInsertRowid,
        ),
      );
    },
    prune(beforeTs: string): number {
      return db.immediate(
        () => db.prepare("DELETE FROM resource_sample WHERE ts < ?").run(beforeTs).changes,
      );
    },
  };
}
export type ResourceSampleCommands = ReturnType<typeof createResourceSampleCommands>;
