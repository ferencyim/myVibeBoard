// Prompt registry contract (WP-98): every prompt text any agent receives is registered with a
// default; the owner overrides it globally or per project (db/prompts.ts, store.prompts).
// Runtime-neutral: the Agent behaviour page and the App render with the same helpers.

import { z } from "zod";

/** Who the prompt is for; the Agent behaviour page groups by this, in this order. */
export const PROMPT_ROLES = [
  "master",
  "planner",
  "executor",
  "scout",
  "reviewer",
  "verifier",
  "maintenance",
  "context",
  "handoff",
  "watchdog",
] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];
export const PromptRoleSchema = z.enum(PROMPT_ROLES);

export const PromptPlaceholderSchema = z.object({ name: z.string().min(1), description: z.string() });
export type PromptPlaceholder = z.infer<typeof PromptPlaceholderSchema>;

/** What a plugin registers. Keys are `domain.name` (dots, no `@`); stable once released. */
export const PromptDefSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]*$/, "prompt key: lowercase letters, digits, . _ -"),
  plugin: z.string().min(1),
  role: PromptRoleSchema,
  title: z.string().min(1),
  description: z.string().default(""),
  /** When the text is sent (trigger), shown to the owner. */
  whenSent: z.string().default(""),
  /** Who receives it (agent role), shown to the owner. */
  audience: z.string().default(""),
  defaultText: z.string(),
  placeholders: z.array(PromptPlaceholderSchema).default([]),
  /**
   * Appended after the (possibly overridden) body. Carries the reply format the parsers expect or
   * a process contract, so a customised body can never break the flow. Read-only for the owner.
   */
  fixedSuffix: z.string().default(""),
  /** Position inside the role group. */
  order: z.number().int().default(0),
});
export type PromptDef = z.input<typeof PromptDefSchema>;
export type PromptDefParsed = z.output<typeof PromptDefSchema>;

export type PromptSource = "default" | "global" | "project";

/** An override whose prompt key is no longer registered (merged or deleted); shown to the owner. */
export interface PromptOrphan {
  key: string;
  /** null = global override. */
  projectId: string | null;
}

/** A registered prompt as listed: definition + overrides + the text that is in effect. */
export interface PromptInfo extends PromptDefParsed {
  globalOverride: string | null;
  /** Only filled when a project was asked for. */
  projectOverride: string | null;
  source: PromptSource;
  effectiveText: string;
  /** Project ids that carry an override of this prompt. */
  overriddenProjects: string[];
}

export const PROMPT_OVERRIDE_MAX_CHARS = 100_000;

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Replace `{{name}}` in ONE pass: substituted values are never scanned again, so text that
 * contains `{{...}}` (a card description, a transcript) cannot inject or loop. Unknown names
 * become empty.
 */
export function renderPromptTemplate(template: string, vars: Record<string, string> = {}): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => vars[name] ?? "");
}

/** Placeholder names used in `text` that the prompt does not declare. */
export function unknownPromptPlaceholders(
  text: string,
  placeholders: ReadonlyArray<{ name: string }>,
): string[] {
  const known = new Set(placeholders.map((p) => p.name));
  const found = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  return [...new Set(found.filter((n) => !known.has(n)))];
}

/** Body + the fixed suffix, separated by a blank line. */
export function composePrompt(body: string, fixedSuffix: string): string {
  if (!fixedSuffix) return body;
  return body ? `${body}\n\n${fixedSuffix}` : fixedSuffix;
}

/** Sync row id of an override: `<key>@<projectId>` or `<key>@*` for the global one. */
export function promptOverrideId(key: string, projectId?: string | null): string {
  return `${key}@${projectId ?? "*"}`;
}

export function parsePromptOverrideId(id: string): { key: string; projectId: string | null } | null {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  const scope = id.slice(at + 1);
  return { key: id.slice(0, at), projectId: scope === "*" ? null : scope };
}
