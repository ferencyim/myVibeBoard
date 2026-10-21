// Default CollectorRegistry: web, backend and android collectors, all reading the verify config
// of the running verification first (written by the verifier agent into its output directory),
// then `<worktree>/.vibe/verify.json`.

import {
  createCollectorRegistry,
  type CollectorContext,
  type CollectorRegistry,
} from "./vibe/contract";
import {
  createAndroidCollector,
  createBackendCollector,
  createDesktopCollector,
  createIosCollector,
  createInMemoryLeaseProvider,
  createNodeServerLauncher,
  createNodeSpawner,
  createWebCollector,
  type VerifyConfig,
} from "./collectors";
import { loadVerifyConfig } from "./collectors/common";
import type { DeviceLeaseProvider } from "./collectors/android/types";

/** verificationId -> config the verifier agent wrote for this run. */
export type RunConfigs = Map<string, VerifyConfig>;

export interface RegistryOptions {
  configs: RunConfigs;
  /** Device leases for Android (index.server.ts passes the device_lease backed provider). */
  leases?: DeviceLeaseProvider;
  /** Default wait for a dev server's ready URL in milliseconds (a verify.json value wins). */
  readyTimeoutMs?: () => number;
}

export function createVerifyRegistry(options: RegistryOptions): CollectorRegistry {
  const resolve = (ctx: CollectorContext): VerifyConfig =>
    options.configs.get(ctx.verificationId) ?? loadVerifyConfig(ctx.worktreePath);
  const registry = createCollectorRegistry();
  const launcher = createNodeServerLauncher({ readyTimeoutMs: options.readyTimeoutMs });
  registry.register(createWebCollector({ loadConfig: resolve, launcher }));
  registry.register(createBackendCollector({ loadConfig: resolve, launcher }));
  registry.register(
    createAndroidCollector({
      leases:
        options.leases ??
        createInMemoryLeaseProvider([{ deviceId: "emulator-5554", serial: "emulator-5554" }]),
      spawner: createNodeSpawner(),
      app: (ctx) => {
        const app = resolve(ctx).android?.app;
        if (!app) throw new Error("No android.app in the verify config");
        return app;
      },
      flow: (ctx) => resolve(ctx).android?.flow,
    }),
  );
  registry.register(
    createIosCollector({
      config: (ctx) => {
        const ios = resolve(ctx).ios;
        if (!ios) throw new Error("No ios section in the verify config");
        return ios;
      },
    }),
  );
  registry.register(
    createDesktopCollector({
      config: (ctx) => {
        const desktop = resolve(ctx).desktop;
        if (!desktop) throw new Error("No desktop section in the verify config");
        return desktop;
      },
    }),
  );
  return registry;
}
