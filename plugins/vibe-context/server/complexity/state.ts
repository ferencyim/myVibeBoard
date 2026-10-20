// Per-session complexity bookkeeping, persisted in vibe_meta so it survives daemon restarts:
// effective turn windows, the compaction baseline, early-compaction count, inherited floor.
// Plus the cwd -> tight memory budget hint that the agent.create injection hook reads.

import type { SessionComplexity } from "../vibe/contract";
import type { VibeDb } from "../vibe/db";
import type { TurnWindow } from "./usage";

export interface ComplexityState {
  /** Effective turns since the last compaction. */
  windows: TurnWindow[];
  /** Usage rows at or before this ISO time belong to an earlier context. */
  baselineTs: string | null;
  /** Early compactions of this session while it was long (carried over a handoff). */
  longCompactions: number;
  /** Lower bound inherited through a handoff (never "long"). */
  floor: SessionComplexity | null;
}

type MetaDb = Pick<VibeDb, "prepare">;

const MAX_WINDOWS = 500;
const stateKey = (sessionId: string) => `context:complexity:${sessionId}`;
const tightKey = (cwd: string) => `context:tight:${cwd.replace(/\\/g, "/").toLowerCase()}`;
const empty = (): ComplexityState => ({
  windows: [],
  baselineTs: null,
  longCompactions: 0,
  floor: null,
});

function getMeta(db: MetaDb, key: string): string | undefined {
  return db.prepare<{ value: string }>("SELECT value FROM vibe_meta WHERE key = ?").get(key)?.value;
}

function setMeta(db: MetaDb, key: string, value: string | null) {
  if (value === null) db.prepare("DELETE FROM vibe_meta WHERE key = ?").run(key);
  else
    db.prepare(
      "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
}

export function readState(db: MetaDb, sessionId: string): ComplexityState {
  try {
    const raw = getMeta(db, stateKey(sessionId));
    return raw ? { ...empty(), ...(JSON.parse(raw) as Partial<ComplexityState>) } : empty();
  } catch {
    return empty();
  }
}

export function writeState(db: MetaDb, sessionId: string, state: ComplexityState) {
  const windows = state.windows.slice(-MAX_WINDOWS);
  setMeta(db, stateKey(sessionId), JSON.stringify({ ...state, windows }));
}

export function updateState(
  db: MetaDb,
  sessionId: string,
  change: (state: ComplexityState) => void,
): ComplexityState {
  const state = readState(db, sessionId);
  change(state);
  writeState(db, sessionId, state);
  return state;
}

/** Remember (tokens) or forget (null) that agents in this directory want a tight memory budget. */
export function setTightBudget(db: MetaDb, cwd: string, tokens: number | null) {
  setMeta(db, tightKey(cwd), tokens === null ? null : String(tokens));
}

export function tightBudgetFor(db: MetaDb, cwd: string): number | undefined {
  try {
    const raw = getMeta(db, tightKey(cwd));
    return raw === undefined ? undefined : Number(raw);
  } catch {
    return undefined;
  }
}
