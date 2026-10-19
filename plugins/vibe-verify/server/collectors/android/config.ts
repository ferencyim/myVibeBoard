// Zod schema of the `android` section of `<worktree>/.vibe/verify.json` (see VerifyConfigSchema).

import { z } from "zod";

export const AdbStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("launch") }),
  z.object({ type: z.literal("deeplink"), uri: z.string() }),
  z.object({ type: z.literal("tap"), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal("swipe"),
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    durationMs: z.number().optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("key"), key: z.string() }),
  z.object({ type: z.literal("wait"), ms: z.number().max(10_000) }),
  z.object({ type: z.literal("screenshot"), label: z.string() }),
]);

export const AndroidFlowSchema = z.object({
  /** Maestro flow file (absolute, or relative to the worktree). Falls back to `steps` without maestro. */
  maestroFile: z.string().optional(),
  steps: z.array(AdbStepSchema).optional(),
});

export const MetroConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Relative to the worktree. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  port: z.number().default(8081),
  /** Max wait for the first full bundle; SPIKE-ANDROID measured ~145 s cold. */
  warmupTimeoutMs: z.number().optional(),
});

export const AndroidAppConfigSchema = z.object({
  packageName: z.string(),
  /**
   * "bundled": APK embeds the JS bundle (release or any bundled build): install and launch.
   * "debug-metro": debug APK without a bundle: start Metro, `adb reverse`, warm the bundle, then
   * open the dev-client URI.
   */
  mode: z.enum(["bundled", "debug-metro"]).default("bundled"),
  /** APK to install (absolute or worktree-relative). Omit when the app is already installed. */
  apkPath: z.string().optional(),
  /** `pkg/.Activity`; default resolves the LAUNCHER activity. */
  activity: z.string().optional(),
  /** Deep link used instead of the launcher (debug-metro: `{metroUrl}` is replaced, URL-encoded). */
  launchUri: z.string().optional(),
  metro: MetroConfigSchema.optional(),
  /** Wait for the app process after launch (default 30 s). */
  launchTimeoutMs: z.number().optional(),
  /** Grace period before the final screenshot/logcat (default 1500). */
  settleMs: z.number().optional(),
});

export const AndroidConfigSchema = z.object({
  app: AndroidAppConfigSchema,
  flow: AndroidFlowSchema.optional(),
});
