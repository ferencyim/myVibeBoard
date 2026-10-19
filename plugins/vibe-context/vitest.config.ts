import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
// Git-heavy tests (inject) are slow on a loaded Windows machine.
export default defineConfig({ test: { testTimeout: 30_000 } });
