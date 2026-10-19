import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
// inject tests drive real git worktrees, which can take several seconds on a loaded Windows machine.
export default defineConfig({ test: { testTimeout: 30_000 } });
