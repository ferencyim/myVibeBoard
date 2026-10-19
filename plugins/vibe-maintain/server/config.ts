// .vibe/maintenance.yml: per-project maintenance rules. The built-in "git-health" rule applies to
// every project unless the file overrides it by name (e.g. `enabled: false`).
//
//   rules:
//     - name: git-health            # same name as a built-in = override it
//       enabled: true
//       trigger: { kind: workload, cards_done: 10, commits_merged: 30 }   # any reached threshold
//       # trigger: { kind: time, cron: "0 3 * * *" }
//       # trigger: { kind: event, path: logs/crash.log, pattern: "Exception" }
//       check: { type: git, stale_days: 14 }
//       agent: null                 # null = deterministic only; "claude/sonnet" = read-only sub agent
//       output: suggest             # suggest = draft card | fix = worktree + in_progress card
//       priority: low
//       dedupe_key: git-health
//       daily_cap: 1

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const RuleDefSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    trigger: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("workload"),
        cards_done: z.number().int().positive().optional(),
        commits_merged: z.number().int().positive().optional(),
        tokens: z.number().int().positive().optional(),
      }),
      z.object({ kind: z.literal("time"), cron: z.string().min(1) }),
      z.object({
        kind: z.literal("event"),
        /** Relative to the repository root unless absolute. */
        path: z.string().min(1),
        /** Regular expression; only appended lines that match fire the rule. Default: any append. */
        pattern: z.string().optional(),
      }),
    ]),
    check: z.object({ type: z.string().min(1) }).passthrough(),
    agent: z.string().nullish(),
    output: z.enum(["suggest", "fix"]).default("suggest"),
    priority: z.string().default("low"),
    dedupe_key: z.string().nullish(),
    daily_cap: z.number().int().min(0).default(1),
  })
  .superRefine((rule, ctx) => {
    if (rule.trigger.kind === "workload") {
      const t = rule.trigger;
      if (!t.cards_done && !t.commits_merged && !t.tokens) {
        ctx.addIssue({
          code: "custom",
          message: "workload trigger needs cards_done, commits_merged or tokens",
        });
      }
    }
  });
export type RuleDef = z.output<typeof RuleDefSchema>;

export const BUILTIN_RULES: RuleDef[] = [
  RuleDefSchema.parse({
    name: "git-health",
    trigger: { kind: "workload", cards_done: 10, commits_merged: 30 },
    check: { type: "git" },
    output: "suggest",
    priority: "low",
    dedupe_key: "git-health",
    daily_cap: 1,
  }),
];

export interface LoadedConfig {
  rules: RuleDef[];
  errors: string[];
  /** The file's mtime-independent text, to detect changes. */
  signature: string;
}

/** Built-ins + `<repo>/.vibe/maintenance.yml`. A broken file keeps the built-ins and reports errors. */
export async function loadConfig(repoPath: string): Promise<LoadedConfig> {
  const errors: string[] = [];
  let text = "";
  try {
    text = await readFile(join(repoPath, ".vibe", "maintenance.yml"), "utf8");
  } catch {
    // No file: built-ins only.
  }
  const byName = new Map(BUILTIN_RULES.map((r) => [r.name, r]));
  if (text.trim()) {
    try {
      const doc = parse(text) as { rules?: unknown } | null;
      const list = Array.isArray(doc?.rules) ? doc.rules : [];
      for (const [i, raw] of list.entries()) {
        const parsed = RuleDefSchema.safeParse(raw);
        if (parsed.success) byName.set(parsed.data.name, parsed.data);
        else {
          errors.push(
            `rules[${i}]: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`,
          );
        }
      }
    } catch (error) {
      errors.push(`maintenance.yml: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rules: [...byName.values()], errors, signature: text };
}
