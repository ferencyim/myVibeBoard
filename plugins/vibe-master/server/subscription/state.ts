// Small JSON state file under <VIBE_HOME>/master. Cards, assessments and plans live in vibe.db and
// the memory files; this only remembers which subscription the owner picked and the running agent,
// so a daemon restart or a provider switch does not lose its place.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MasterTarget } from "../../shared/rpc";

export interface MasterAgentRecord {
  agentId: string;
  sessionId: string;
  target: MasterTarget;
}

export interface MasterAlert {
  kind: string;
  message: string;
  at: string;
}

export interface MasterStateData {
  /** Set by a manual switch; overrides the settings default until switched again. */
  target?: MasterTarget;
  agent?: MasterAgentRecord;
  lastAlert?: MasterAlert;
}

export interface MasterStateFile {
  read(): MasterStateData;
  update(patch: (data: MasterStateData) => MasterStateData): MasterStateData;
}

export function createStateFile(dir: string): MasterStateFile {
  const path = join(dir, "state.json");
  const read = (): MasterStateData => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as MasterStateData;
    } catch {
      return {};
    }
  };
  return {
    read,
    update(patch) {
      const next = patch(read());
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, path);
      return next;
    },
  };
}
