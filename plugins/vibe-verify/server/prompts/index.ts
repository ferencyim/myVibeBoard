// Prompt resolution for vibe-verify: the registry (store.prompts) when available, the registered
// defaults otherwise, so pure helpers and a missing database behave the same.

import {
  PromptDefSchema,
  composePrompt,
  renderPromptTemplate,
  type PromptDefParsed,
} from "../vibe/contract";
import type { VibeStore } from "../vibe/db";
import { VERIFY_PROMPT_DEFS } from "./defs";

export { VERIFY_PROMPT_DEFS };

export interface ResolveOptions {
  projectId?: string | null;
  vars?: Record<string, string>;
}

/** What the pure helpers need; satisfied by `defaultPrompts` and `createVerifyPrompts(store)`. */
export interface PromptResolver {
  resolve(key: string, options?: ResolveOptions): string;
}

const parsed = new Map<string, PromptDefParsed>(
  VERIFY_PROMPT_DEFS.map((d) => {
    const def = PromptDefSchema.parse(d);
    return [def.key, def];
  }),
);

/** Defaults + fixed suffix rendered the way the registry does (no database, no overrides). */
export const defaultPrompts: PromptResolver = {
  resolve(key, options = {}) {
    const def = parsed.get(key);
    if (!def) throw new Error(`Unknown prompt: ${key}`);
    const body =
      def.placeholders.length > 0
        ? renderPromptTemplate(def.defaultText, options.vars ?? {})
        : def.defaultText;
    return composePrompt(body, def.fixedSuffix);
  },
};

export function createVerifyPrompts(store: Pick<VibeStore, "prompts">) {
  return {
    /** Upsert the defaults; called once at start-up. */
    register(options: { pruneMissing?: boolean } = { pruneMissing: true }): void {
      store.prompts.register(VERIFY_PROMPT_DEFS, options);
    },
    resolve(key: string, options: ResolveOptions = {}): string {
      try {
        return store.prompts.resolve(key, options);
      } catch {
        return defaultPrompts.resolve(key, options); // database unavailable or key not registered yet
      }
    },
  };
}
export type VerifyPrompts = ReturnType<typeof createVerifyPrompts>;
