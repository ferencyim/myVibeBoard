import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});
