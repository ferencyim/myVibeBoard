// Synthetic log fixtures (hand-made, no real log content) and shared setup.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateOwner, openVibeDb } from "../server/vibe/db";
import type { LogRoot } from "../server/paths";
import { resolveRoots } from "../server/paths";

export function tempDir(prefix = "vibe-stats-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function openTestDb() {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "stats");
  return db;
}

export const lines = (...objs: unknown[]) => objs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n") + "\n";

export function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
export const append = (file: string, content: string) => appendFileSync(file, content);

export function rootsFor(base: string): LogRoot[] {
  return resolveRoots({
    claude: [join(base, "claude", "projects")],
    codex: [join(base, "codex", "sessions")],
    kimi: [join(base, "kimi", "sessions")],
    deepseek: [join(base, "dsh", "sessions")],
  });
}

const usage = (i: number, o: number, cr: number, cw: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
});

export const claudeLine = (
  ts: string,
  id: string | null,
  req: string | null,
  u: [number, number, number, number],
  model = "claude-sonnet-4-5",
) => ({
  type: "assistant",
  timestamp: ts,
  sessionId: "sess-claude-1",
  ...(req ? { requestId: req } : {}),
  message: { ...(id ? { id } : {}), model, role: "assistant", usage: usage(...u) },
});

/** Expected totals: in 115, out 455, cacheRead 2200, cacheWrite 200 over 3 messages. */
export const CLAUDE_FIXTURE = lines(
  { type: "user", timestamp: "2026-10-01T10:00:00.000Z", sessionId: "sess-claude-1", message: { role: "user", content: "hi" } },
  claudeLine("2026-10-01T10:00:04.000Z", "msg_1", "req_1", [100, 50, 1000, 200]),
  claudeLine("2026-10-01T10:00:06.000Z", "msg_1", "req_1", [100, 50, 1000, 200]),
  { type: "user", timestamp: "2026-10-01T10:00:10.000Z", sessionId: "sess-claude-1", message: { role: "user", content: "tool" } },
  claudeLine("2026-10-01T10:00:20.000Z", "msg_2", "req_2", [10, 400, 1200, 0]),
  claudeLine("2026-10-01T10:00:25.000Z", "msg_x", "req_x", [0, 0, 0, 0], "<synthetic>"),
  "this line is not json",
  claudeLine("2026-10-01T10:00:30.000Z", null, null, [5, 5, 0, 0]),
);

const codexTc = (ts: string, total: object | null, last?: object) => ({
  timestamp: ts,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: total ? { total_token_usage: total, last_token_usage: last ?? total } : null,
  },
});

export const CODEX_HEAD = lines(
  { timestamp: "2026-10-01T11:00:00.000Z", type: "session_meta", payload: { id: "sess-codex-1", cwd: "<cwd>" } },
  { timestamp: "2026-10-01T11:00:01.000Z", type: "turn_context", payload: { model: "gpt-5-codex" } },
  codexTc("2026-10-01T11:00:05.000Z", { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 }),
  codexTc("2026-10-01T11:00:05.500Z", { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 }),
  codexTc("2026-10-01T11:00:06.000Z", null),
);
/** Second step: cumulative 3300; last_token_usage is the step alone. */
export const CODEX_TAIL = lines(
  codexTc(
    "2026-10-01T11:00:15.000Z",
    { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 300, reasoning_output_tokens: 50, total_tokens: 3300 },
    { input_tokens: 2000, cached_input_tokens: 1200, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 2200 },
  ),
);

export const KIMI_FIXTURE = lines(
  { type: "metadata", protocol_version: "1.1" },
  { timestamp: 1790852400.5, message: { type: "TurnBegin", payload: {} } },
  { timestamp: 1790852404.5, message: { type: "StatusUpdate", payload: { message_id: "m1", token_usage: { input_other: 50, output: 20, input_cache_read: 100, input_cache_creation: 10 } } } },
  { timestamp: 1790852404.9, message: { type: "StatusUpdate", payload: { message_id: "m1", token_usage: { input_other: 50, output: 20, input_cache_read: 100, input_cache_creation: 10 } } } },
);

export const DEEPSEEK_FIXTURE = lines(
  { timestamp: "2026-10-01T12:00:00.000Z", session_id: "sess-ds-1", type: "request" },
  { timestamp: "2026-10-01T12:00:04.000Z", session_id: "sess-ds-1", id: "r1", model: "deepseek-chat", usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } },
);
