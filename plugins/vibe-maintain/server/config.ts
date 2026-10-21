// .vibe/maintenance.yml: a project's local override of the rules, the top layer of the rule configuration
// (built-in default < global UI rules < this file; see shared/rules.ts). A rule with the name of an
// existing rule overrides only the fields it writes; a new name must be complete.
//
//   rules:
//     - name: git-health            # same name as a built-in = override those fields
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
//       prompts:                    # optional {{placeholder}} templates, see shared/prompts.ts
//         review: "..."
//         fix: "..."

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { RuleDefSchema, RuleFieldsSchema, type RuleDef, type YmlRule } from "../shared/rules";

export { RuleDefSchema, type RuleDef };

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
  /** The rules written in the file, with only the fields each one sets. */
  yml: YmlRule[];
  errors: string[];
  /** The file's text with LF endings, to detect changes. */
  signature: string;
}

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ");

/** `<repo>/.vibe/maintenance.yml`. A broken file yields no rules and reports errors. */
export async function loadConfig(repoPath: string): Promise<LoadedConfig> {
  const errors: string[] = [];
  const yml: YmlRule[] = [];
  let text = "";
  try {
    // A CRLF checkout must not look like an edit (the signature) nor leak "\r" into rule values.
    text = (await readFile(join(repoPath, ".vibe", "maintenance.yml"), "utf8")).replace(/\r\n/g, "\n");
  } catch {
    // No file: the lower layers only.
  }
  if (text.trim()) {
    try {
      const doc = parse(text) as { rules?: unknown } | null;
      const list = Array.isArray(doc?.rules) ? doc.rules : [];
      for (const [i, raw] of list.entries()) {
        const name = (raw as { name?: unknown } | null)?.name;
        const parsed = RuleFieldsSchema.safeParse(raw);
        if (typeof name !== "string" || !name) errors.push(`rules[${i}]: name is required`);
        else if (!parsed.success) errors.push(`rules[${i}]: ${issues(parsed.error)}`);
        else yml.push({ name, fields: parsed.data });
      }
    } catch (error) {
      errors.push(`maintenance.yml: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { yml, errors, signature: text };
}
