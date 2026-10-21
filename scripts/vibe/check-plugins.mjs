// Verify every vibe plugin (plugins/vibe-* whose package.json has a `vibe` key) declares the
// Paseo range of this checkout in paseo-plugin.json (run after merging an upstream release; fix
// with the printed range), and that its client bundle never reaches a server/ module: the daemon's
// plugin compiler refuses such a bundle at load time, which unit tests and tsc do not catch.
// Usage: node scripts/vibe/check-plugins.mjs [--root <dir>]
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../is-main-module.mjs";
import { defaultRepoRoot, listVibePlugins, readJson, repoPaseoRange } from "./lib.mjs";

export function checkPlugins(root = defaultRepoRoot()) {
  const expected = repoPaseoRange(root);
  const problems = [];
  const plugins = listVibePlugins(root);
  for (const plugin of plugins) {
    let actual;
    try {
      actual = readJson(path.join(plugin.dir, "paseo-plugin.json")).requirements?.paseo;
    } catch (error) {
      problems.push(`${plugin.name}: cannot read paseo-plugin.json (${error.message})`);
      continue;
    }
    if (actual !== expected) {
      problems.push(
        `${plugin.name}: requirements.paseo is ${JSON.stringify(actual)}, expected "${expected}"`,
      );
    }
  }
  for (const plugin of plugins) {
    for (const leak of clientServerImports(plugin.dir)) {
      problems.push(`${plugin.name}: client bundle imports server-only module ${leak}`);
    }
  }
  return { expected, checked: plugins.length, problems };
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

/** Relative imports reachable from index.client.tsx that resolve under <plugin>/server/. */
export function clientServerImports(pluginDir) {
  const entry = ["index.client.tsx", "index.client.ts"]
    .map((f) => path.join(pluginDir, f))
    .find(existsSync);
  if (!entry) return [];
  const serverDir = path.join(pluginDir, "server") + path.sep;
  const seen = new Set();
  const leaks = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    // Type-only imports are erased before bundling.
    const source = readFileSync(file, "utf8")
      .replace(/import\s+type\s[^;]*;/g, "")
      .replace(/export\s+type\s[^;]*;/g, "");
    for (const match of source.matchAll(IMPORT_RE)) {
      const base = path.resolve(path.dirname(file), match[1]);
      const resolved = EXTENSIONS.map((ext) => base + ext).find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      if (!resolved || seen.has(resolved)) continue;
      if (resolved.startsWith(serverDir)) {
        leaks.push(
          `${path.relative(pluginDir, resolved)} (from ${path.relative(pluginDir, file)})`,
        );
        continue;
      }
      stack.push(resolved);
    }
  }
  return leaks;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const { expected, checked, problems } = checkPlugins(
    rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : defaultRepoRoot(),
  );
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`OK: ${checked} vibe plugin(s) declare paseo ${expected}`);
}
