import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
// Tests drive real SQLite files, which can be slow on a loaded Windows machine.
export default defineConfig({
  resolve: {
    // UI tests use the root React renderer; components must use that same React instance.
    alias: [
      { find: /^react$/, replacement: fileURLToPath(new URL("../../node_modules/react/index.js", import.meta.url)) },
      { find: /^react\/(jsx-runtime|jsx-dev-runtime)$/, replacement: fileURLToPath(new URL("../../node_modules/react/$1.js", import.meta.url)) },
    ],
  },
  test: { testTimeout: 30_000 },
});
