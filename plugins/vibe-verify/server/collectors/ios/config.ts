// Zod schema of the `ios` section of `<worktree>/.vibe/verify.json` (see VerifyConfigSchema).
// The Mac host is deliberately NOT required here: it normally comes from the plugin options / the
// user's local environment (an ssh alias from ~/.ssh/config). The repo only ever says `<MAC_HOST>`.

import { z } from "zod";

export const IosStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("launch") }),
  z.object({ type: z.literal("openurl"), url: z.string() }),
  z.object({ type: z.literal("terminate") }),
  z.object({ type: z.literal("wait"), ms: z.number().max(10_000) }),
  z.object({ type: z.literal("screenshot"), label: z.string() }),
]);

export const IosAppConfigSchema = z.object({
  bundleId: z.string().regex(/^[A-Za-z0-9.-]+$/, "invalid bundle id"),
  /**
   * Without `build`: local .app directory (worktree-relative or absolute), copied to the Mac with
   * scp. With `build`: path of the built .app ON THE MAC (absolute, or relative to build.cwd).
   * Omit when the app is already installed in the simulator.
   */
  appPath: z.string().optional(),
  /** Build on the Mac (xcodebuild ...) instead of syncing a local build product. */
  build: z
    .object({
      /** Directory on the Mac, e.g. a checkout of the project. */
      cwd: z.string(),
      command: z.string(),
      args: z.array(z.string()).default([]),
      timeoutMs: z.number().default(30 * 60_000),
    })
    .optional(),
  launchArgs: z.array(z.string()).default([]),
  /** Grace period before the final screenshot (default 1500). */
  settleMs: z.number().optional(),
});

export const IosConfigSchema = z.object({
  /** ssh host alias of the Mac; plugin option / VIBE_MAC_HOST take precedence. */
  host: z.string().optional(),
  /** Simulator name or UDID (ctx.deviceId wins). */
  device: z.string().optional(),
  app: IosAppConfigSchema,
  steps: z.array(IosStepSchema).optional(),
});
export type IosStep = z.infer<typeof IosStepSchema>;
export type IosAppConfig = z.infer<typeof IosAppConfigSchema>;
export type IosConfig = z.infer<typeof IosConfigSchema>;
