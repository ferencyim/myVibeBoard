// Verify every vibe plugin (plugins/vibe-* whose package.json has a `vibe` key) declares the
// Paseo range of this checkout in paseo-plugin.json. Run after merging an upstream release;
// fix with the printed range. Usage: node scripts/vibe/check-plugins.mjs [--root <dir>]
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
  return { expected, checked: plugins.length, problems };
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
