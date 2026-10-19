// Zod schema of the `desktop` section of `<worktree>/.vibe/verify.json` (see VerifyConfigSchema).

import { z } from "zod";

export const DesktopStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), ms: z.number().max(10_000) }),
  z.object({ type: z.literal("screenshot"), label: z.string() }),
  // The next three need `automation: "electron"` (Playwright); otherwise they are skipped with a note.
  z.object({ type: z.literal("click"), selector: z.string() }),
  z.object({ type: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("press"), key: z.string() }),
]);

export const DesktopAppConfigSchema = z.object({
  /** Executable of the built app: absolute, or worktree-relative (e.g. packages/desktop/release/win-unpacked/Paseo.exe). */
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Relative to the worktree. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Regex (source) matched against window titles; default: the window of the launched process. */
  windowTitle: z.string().optional(),
  windowTimeoutMs: z.number().default(30_000),
  /** Grace period before the final screenshot (default 1500). */
  settleMs: z.number().optional(),
  /** "electron": drive the app through Playwright `_electron` (click/fill/press steps). */
  automation: z.enum(["none", "electron"]).default("none"),
});

export const DesktopConfigSchema = z.object({
  app: DesktopAppConfigSchema,
  steps: z.array(DesktopStepSchema).optional(),
});
export type DesktopStep = z.infer<typeof DesktopStepSchema>;
export type DesktopAppConfig = z.infer<typeof DesktopAppConfigSchema>;
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;
