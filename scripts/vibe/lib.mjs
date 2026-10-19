import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHARED_PACKAGE_DIR = "plugins/vibe-shared";

export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// "0.12.0" -> ">=0.12.0 <0.13.0": the Paseo range every vibe plugin declares in
// `paseo-plugin.json` (`requirements.paseo`); Paseo itself refuses incompatible plugins.
export function paseoRangeFor(version) {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  if (!match) throw new Error(`Cannot derive a Paseo range from version "${version}"`);
  const [, major, minor] = match;
  return `>=${major}.${minor}.0 <${major}.${Number(minor) + 1}.0`;
}

export function repoPaseoRange(root) {
  return paseoRangeFor(readJson(path.join(root, "package.json")).version);
}

// Plugins opt into the vibe conventions with a top-level `vibe` object in package.json:
//   "vibe": { "shared": { "shared": ["contract", "sync"], "server": ["db"] } }
export function listVibePlugins(root) {
  const pluginsDir = path.join(root, "plugins");
  if (!existsSync(pluginsDir)) return [];
  const result = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("vibe-")) continue;
    const manifestPath = path.join(pluginsDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const pkg = readJson(manifestPath);
    if (pkg.vibe) result.push({ name: entry.name, dir: path.join(pluginsDir, entry.name), pkg });
  }
  return result;
}
