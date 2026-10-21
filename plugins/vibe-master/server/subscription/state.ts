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
  /** Permission mode the agent was created with (null = provider default). */
  modeId?: string | null;
  /** Hash of the rules text the agent was started with / last received (see master/session.ts). */
  rulesHash?: string;
}

export interface MasterAlert {
  kind: string;
  message: string;
  at: string;
}

export interface MasterStateData {
  /** Set by a manual switch; overrides the settings default until switched again. */
  target?: MasterTarget;
  /** Set by a manual permission switch; overrides the settings default until switched back. */
  permissionMode?: string;
  agent?: MasterAgentRecord;
  lastAlert?: MasterAlert;
  /** Per master session (agent_session id): what it ran on and why it was replaced. */
  sessions?: Record<string, MasterSessionNote>;
}

export interface MasterSessionNote {
  /** Provider the agent actually ran on (agent_session.currentProvider is rewritten by a switch). */
  provider?: string;
  model: string;
  thinking: string | null;
  retiredReason?: string;
  retiredAt?: string;
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
