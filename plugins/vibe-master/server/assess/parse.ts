// Pull one JSON object out of a model reply (fenced block, or the first balanced {...}).

import type { z } from "zod";

function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/** Candidate JSON strings, best first: the last fenced block, then each top-level object. */
export function jsonCandidates(reply: string): string[] {
  const out: string[] = [];
  const fences = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (const m of fences.reverse()) out.push(m[1]!.trim());
  for (let i = reply.indexOf("{"); i >= 0 && i < reply.length; i = reply.indexOf("{", i + 1)) {
    const obj = balancedObject(reply, i);
    if (obj) {
      out.push(obj);
      i += obj.length - 1;
    }
  }
  return out;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseReply<S extends z.ZodType>(reply: string, schema: S): ParseResult<z.output<S>> {
  const candidates = jsonCandidates(reply);
  if (candidates.length === 0) return { ok: false, error: "The reply contains no JSON object." };
  let lastError = "";
  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch (error) {
      lastError = `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, value: parsed.data };
    lastError = parsed.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  return { ok: false, error: lastError };
}
