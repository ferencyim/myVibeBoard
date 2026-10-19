// Per-CLI log line parsers. Each parser turns one JSONL line into at most one usage record.
// Claude semantics (dedupe by message.id + requestId, first occurrence wins, 4 token buckets) follow
// ccusage so totals reconcile; the code is written from the log format, not copied (see UPSTREAM.md).
// Kimi and DeepSeek formats are NOT verified against a real install: they are tolerant best-effort.

import { basename, dirname } from "node:path";
import type { UsageProvider } from "../shared/rpc";

export interface UsageRecord {
  ts: string;
  provider: UsageProvider;
  model: string;
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  durationMs: number | null;
  /** Cost reported by the log itself (Claude costUSD), else null and priced at index time. */
  cost: number | null;
  dedupeKey: string;
}

/** Mutable per-file parser memory. Rebuilt by replaying the already-consumed prefix on restart. */
export interface FileState {
  prevTs?: number;
  sessionId?: string;
  model?: string;
  msgId?: string;
  msgStart?: number;
  prevTotal?: number;
}

export interface LineContext {
  file: string;
  /** Byte offset of the line start; only used for dedupe keys of lines without a natural id. */
  offset: number;
}

export interface Parser {
  provider: UsageProvider;
  parseLine(raw: string, state: FileState, ctx: LineContext): UsageRecord | null;
}

const MAX_TURN_MS = 30 * 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function parseJson(raw: string): Obj | null {
  if (!raw.trim()) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Accepts ISO strings, epoch seconds and epoch milliseconds. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? Math.round(v * 1000) : v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** Duration since an earlier timestamp, discarding gaps that are clearly idle time. */
function gap(ts: number, from: number | undefined): number | null {
  if (from === undefined) return null;
  const d = ts - from;
  return d > 0 && d <= MAX_TURN_MS ? d : null;
}

export const claudeParser: Parser = {
  provider: "claude",
  parseLine(raw, state, ctx) {
    const o = parseJson(raw);
    if (!o) return null;
    const ts = toMs(o.timestamp);
    if (ts === null) return null;
    const prev = state.prevTs;
    state.prevTs = ts;
    const message = isObj(o.message) ? o.message : null;
    const usage = message && isObj(message.usage) ? message.usage : null;
    if (!message || !usage) return null;
    if (typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") {
      return null;
    }
    const model = str(message.model) ?? "unknown";
    if (model === "<synthetic>") return null;

    const msgId = str(message.id);
    const requestId = str(o.requestId);
    // A message is logged once per content block; its duration runs from the line before the
    // first block to the last block. Later chunks only extend the duration (see indexer upsert).
    if (!msgId || msgId !== state.msgId) {
      state.msgId = msgId;
      state.msgStart = prev;
    }
    return {
      ts: new Date(ts).toISOString(),
      provider: "claude",
      model,
      sessionId: str(o.sessionId) ?? basename(ctx.file, ".jsonl"),
      tokensIn: num(usage.input_tokens),
      tokensOut: num(usage.output_tokens),
      tokensCacheRead: num(usage.cache_read_input_tokens),
      tokensCacheWrite: num(usage.cache_creation_input_tokens),
      durationMs: gap(ts, state.msgStart),
      cost: typeof o.costUSD === "number" ? o.costUSD : null,
      dedupeKey:
        msgId && requestId ? `claude:${msgId}:${requestId}` : `claude:${ctx.file}:${ctx.offset}`,
    };
  },
};

export const codexParser: Parser = {
  provider: "codex",
  parseLine(raw, state, ctx) {
    const o = parseJson(raw);
    if (!o) return null;
    const ts = toMs(o.timestamp);
    const prev = state.prevTs;
    if (ts !== null) state.prevTs = ts;
    const payload = isObj(o.payload) ? o.payload : null;
    if (!payload) return null;

    if (o.type === "session_meta") {
      state.sessionId = str(payload.id) ?? str(payload.session_id) ?? state.sessionId;
      return null;
    }
    if (o.type === "turn_context") {
      state.model = str(payload.model) ?? state.model;
      return null;
    }
    if (o.type !== "event_msg" || payload.type !== "token_count" || ts === null) return null;
    const info = isObj(payload.info) ? payload.info : null;
    if (!info) return null;
    const total = isObj(info.total_token_usage) ? info.total_token_usage : null;
    const last = isObj(info.last_token_usage) ? info.last_token_usage : null;
    const cumulative = total ? num(total.total_tokens) : 0;
    // Repeated token_count events carry the same cumulative total: count each step once.
    if (total && cumulative > 0 && cumulative === state.prevTotal) return null;
    if (total) state.prevTotal = cumulative;
    const step = last ?? total;
    if (!step) return null;

    const input = num(step.input_tokens);
    const cached = Math.min(num(step.cached_input_tokens), input);
    const sessionId = state.sessionId ?? basename(ctx.file, ".jsonl");
    const natural = cumulative > 0 ? String(cumulative) : `${ctx.file}:${ctx.offset}`;
    return {
      ts: new Date(ts).toISOString(),
      provider: "codex",
      model: state.model ?? "gpt-5",
      sessionId,
      tokensIn: input - cached,
      tokensOut: num(step.output_tokens),
      tokensCacheRead: cached,
      tokensCacheWrite: num(step.cache_write_input_tokens),
      durationMs: gap(ts, prev),
      cost: null,
      dedupeKey: `codex:${sessionId}:${natural}`,
    };
  },
};

// Kimi Code CLI: wire.jsonl lines {timestamp, message:{type:"StatusUpdate", payload:{token_usage}}}.
export const kimiParser: Parser = {
  provider: "kimi",
  parseLine(raw, state, ctx) {
    const o = parseJson(raw);
    if (!o) return null;
    const message = isObj(o.message) ? o.message : null;
    const payload = message && isObj(message.payload) ? message.payload : null;
    const usage = payload && isObj(payload.token_usage) ? payload.token_usage : null;
    const ts = toMs(o.timestamp);
    const prev = state.prevTs;
    if (ts !== null) state.prevTs = ts;
    if (!message || message.type !== "StatusUpdate" || !payload || !usage || ts === null) {
      return null;
    }
    const sessionId = basename(dirname(ctx.file));
    const id = str(payload.message_id);
    return {
      ts: new Date(ts).toISOString(),
      provider: "kimi",
      model: str(payload.model) ?? "kimi",
      sessionId,
      tokensIn: num(usage.input_other),
      tokensOut: num(usage.output),
      tokensCacheRead: num(usage.input_cache_read),
      tokensCacheWrite: num(usage.input_cache_creation),
      durationMs: gap(ts, prev),
      cost: null,
      dedupeKey: id ? `kimi:${sessionId}:${id}` : `kimi:${ctx.file}:${ctx.offset}`,
    };
  },
};

// DeepSeek Harness (dsh): format unverified; accept any line carrying an OpenAI/DeepSeek-style
// usage object (prompt_tokens / completion_tokens / prompt_cache_hit_tokens).
export const deepseekParser: Parser = {
  provider: "deepseek",
  parseLine(raw, state, ctx) {
    const o = parseJson(raw);
    if (!o) return null;
    const ts = toMs(o.timestamp ?? o.ts ?? o.created_at ?? o.created);
    const prev = state.prevTs;
    if (ts !== null) state.prevTs = ts;
    const holders = [o, o.message, o.payload, o.response].filter(isObj);
    const holder = holders.find((h) => isObj(h.usage));
    const usage = holder && isObj(holder.usage) ? holder.usage : null;
    if (!holder || !usage || ts === null) return null;
    const hit = num(usage.prompt_cache_hit_tokens);
    const prompt = num(usage.prompt_tokens ?? usage.input_tokens);
    const miss =
      typeof usage.prompt_cache_miss_tokens === "number"
        ? usage.prompt_cache_miss_tokens
        : Math.max(0, prompt - hit);
    const sessionId = str(o.session_id) ?? str(holder.session_id) ?? basename(ctx.file, ".jsonl");
    const id = str(holder.id) ?? str(o.id);
    return {
      ts: new Date(ts).toISOString(),
      provider: "deepseek",
      model: str(holder.model) ?? str(o.model) ?? "deepseek-chat",
      sessionId,
      tokensIn: miss,
      tokensOut: num(usage.completion_tokens ?? usage.output_tokens),
      tokensCacheRead: hit,
      tokensCacheWrite: 0,
      durationMs: gap(ts, prev),
      cost: null,
      dedupeKey: id ? `deepseek:${sessionId}:${id}` : `deepseek:${ctx.file}:${ctx.offset}`,
    };
  },
};

export const PARSERS: Record<UsageProvider, Parser> = {
  claude: claudeParser,
  codex: codexParser,
  kimi: kimiParser,
  deepseek: deepseekParser,
};
