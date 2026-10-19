// Spike: can a plugin consume `plugins/vibe-shared` through a `file:` dependency?
// Builds a throwaway fixture under the OS temp dir, runs a real `npm install`
// (which creates the node_modules link) and then runs the daemon's plugin compiler
// against it. Prints a JSON verdict. See docs/vibe/SPIKE-SHARED.md.
// Usage: node --import tsx scripts/vibe/spike-shared-file-dep.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { compilePlugin } = await import(
  pathToFileURL(path.join(repoRoot, "packages/server/src/server/plugins/compiler.ts")).href
);

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function buildFixture() {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "vibe-spike-")));
  const shared = path.join(root, "plugins/vibe-shared");
  const plugin = path.join(root, "plugins/vibe-demo");
  write(
    path.join(shared, "package.json"),
    JSON.stringify({ name: "@vibe/shared", version: "0.0.0", type: "module", main: "./index.ts" }),
  );
  write(path.join(shared, "index.ts"), 'export { CARD_COLUMNS } from "./contract/model.ts";\n');
  write(
    path.join(shared, "contract/model.ts"),
    'export const CARD_COLUMNS = ["draft", "todo", "doing", "verify", "done"] as const;\n',
  );
  write(path.join(plugin, "paseo-plugin.json"), JSON.stringify({ id: "vibe-demo" }));
  write(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "vibe-demo",
      version: "0.0.0",
      private: true,
      dependencies: { "@vibe/shared": "file:../vibe-shared" },
    }),
  );
  write(
    path.join(plugin, "index.server.ts"),
    'import { CARD_COLUMNS } from "@vibe/shared";\nexport default function contribute() { return () => { void CARD_COLUMNS; }; }\n',
  );
  write(
    path.join(plugin, "index.client.tsx"),
    'import { CARD_COLUMNS } from "@vibe/shared";\nexport default function contribute() { return () => { void CARD_COLUMNS; }; }\n',
  );
  return { root, plugin };
}

const { root, plugin } = buildFixture();
const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
  cwd: plugin,
  shell: true,
  encoding: "utf8",
});
const verdict = { fixture: root, npmInstallExit: npm.status };
try {
  const out = await compilePlugin({
    client: path.join(plugin, "index.client.tsx"),
    server: path.join(plugin, "index.server.ts"),
  });
  verdict.compiled = true;
  verdict.serverInlinesShared = out.serverBundle.includes('"verify"');
  verdict.clientInlinesShared = out.clientBundle.includes('"verify"');
  verdict.lockfileSpec = JSON.parse(
    readFileSync(path.join(plugin, "package-lock.json"), "utf8"),
  ).packages["node_modules/@vibe/shared"];
} catch (error) {
  verdict.compiled = false;
  verdict.error = String(error?.message ?? error).split("\n")[0];
}
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.compiled ? 0 : 1);
