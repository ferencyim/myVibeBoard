import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageProvider } from "../shared/rpc";

export interface LogRoot {
  provider: UsageProvider;
  dir: string;
  /** Matched against the file path relative to nothing: the full path (forward or back slashes). */
  match: RegExp;
}

const PATTERNS: Record<UsageProvider, RegExp> = {
  claude: /\.jsonl$/,
  codex: /rollout-[^\/]*\.jsonl$/,
  kimi: /wire\.jsonl$/,
  deepseek: /\.jsonl$/,
};

export function defaultLogDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Record<UsageProvider, string[]> {
  const claudeBases = env.CLAUDE_CONFIG_DIR?.trim()
    ? env.CLAUDE_CONFIG_DIR.split(",").map((s) => s.trim())
    : [join(home, ".config", "claude"), join(home, ".claude")];
  return {
    claude: claudeBases.map((b) => join(b, "projects")),
    codex: [join(env.CODEX_HOME?.trim() || join(home, ".codex"), "sessions")],
    // Unverified locations: override through the logDirs setting.
    kimi: [join(home, ".kimi", "sessions")],
    deepseek: [join(env.DSH_HOME?.trim() || join(home, ".dsh"), "sessions")],
  };
}

export function resolveRoots(
  overrides: Partial<Record<UsageProvider, string[]>> = {},
  defaults: Record<UsageProvider, string[]> = defaultLogDirs(),
): LogRoot[] {
  const roots: LogRoot[] = [];
  for (const provider of Object.keys(PATTERNS) as UsageProvider[]) {
    const custom = overrides[provider];
    const dirs = custom && custom.length > 0 ? custom : defaults[provider];
    for (const dir of dirs) roots.push({ provider, dir, match: PATTERNS[provider] });
  }
  return roots;
}
