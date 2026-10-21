// How the master reads its prompts: from the shared registry (owner overrides apply), or - without
// a database, in unit tests - straight from the built-in defaults.

import { createHash } from "node:crypto";
import { PromptDefSchema, composePrompt, renderPromptTemplate } from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { masterPromptDefs, type MasterDefOptions, type MasterPromptKey } from "./defs";

export interface ResolveOptions {
  /** Project of the card the text is for; undefined = global scope only. */
  projectId?: string | null;
  vars?: Record<string, string>;
}

export interface PromptPort {
  resolve(key: MasterPromptKey, options?: ResolveOptions): string;
}

/** Defaults only (no owner overrides). */
export function defaultPromptPort(options: MasterDefOptions = {}): PromptPort {
  const defs = new Map(masterPromptDefs(options).map((d) => [d.key, PromptDefSchema.parse(d)]));
  return {
    resolve(key, opts = {}) {
      const def = defs.get(key);
      if (!def) throw new Error(`Unknown prompt ${key}`);
      const body =
        def.placeholders.length > 0
          ? renderPromptTemplate(def.defaultText, opts.vars ?? {})
          : def.defaultText;
      return composePrompt(body, def.fixedSuffix);
    },
  };
}

/** Registry-backed port; `register` upserts the defaults (call on start and when the flags change). */
export function createPromptPort(
  store: VibeStore,
  options: () => MasterDefOptions,
): PromptPort & { register(): void } {
  return {
    register: () => store.prompts.register(masterPromptDefs(options()), { pruneMissing: true }),
    resolve: (key, opts = {}) => store.prompts.resolve(key, opts),
  };
}

/** Static rules + the owner's supplement (as one system prompt). */
export function composeRules(base: string, supplement: string): string {
  const extra = supplement.trim();
  return extra ? `${base}\n\n## Owner supplement (from settings)\n\n${extra}` : base;
}

/** The full system prompt for a scope: rules body + supplement. */
export function rulesFor(prompts: PromptPort, projectId?: string | null): string {
  return composeRules(
    prompts.resolve("master.rules", { projectId }),
    prompts.resolve("master.rules_supplement", { projectId }),
  );
}

export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Message for an agent that already saw other rules: the notice plus the full new rules. */
export function rulesUpdateMessage(
  prompts: PromptPort,
  rules: string,
  projectId?: string | null,
): string {
  return prompts.resolve("master.rules_updated", { projectId, vars: { rules } });
}
