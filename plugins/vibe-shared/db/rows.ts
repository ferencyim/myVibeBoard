// Generic DB row <-> domain object mapping (see contract/model.ts for the conventions).

import type { z } from "zod";

const BOOLEAN_COLUMNS = new Set([
  "needs_evidence",
  "builtin",
  "evidence",
  "simulated",
  "archived",
  "enabled",
]);

function camel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** snake_case row -> camelCase object; `*_json` parsed; 0/1 flags to booleans. */
export function decodeRow<S extends z.ZodType>(
  schema: S,
  row: Record<string, unknown>,
): z.infer<S> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_json")) {
      out[camel(key.slice(0, -5))] = typeof value === "string" ? JSON.parse(value) : value;
    } else if (BOOLEAN_COLUMNS.has(key)) {
      out[camel(key)] = value === 1 || value === true;
    } else {
      out[camel(key)] = value;
    }
  }
  return schema.parse(out);
}

export function decodeRows<S extends z.ZodType>(
  schema: S,
  rows: Record<string, unknown>[],
): z.infer<S>[] {
  return rows.map((r) => decodeRow(schema, r));
}
