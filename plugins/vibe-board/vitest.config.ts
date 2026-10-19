import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
// git-finalize and sync tests drive real git repos / SQLite files, which can be slow on a loaded Windows machine.
export default defineConfig({ test: { testTimeout: 30_000 } });
