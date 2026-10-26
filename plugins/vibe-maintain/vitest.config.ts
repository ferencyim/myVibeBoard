import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up. Real git on Windows is slow.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
