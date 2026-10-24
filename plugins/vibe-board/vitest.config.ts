import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
// Git finalization tests use real isolated repositories.
export default defineConfig({ test: { testTimeout: 30_000 } });
