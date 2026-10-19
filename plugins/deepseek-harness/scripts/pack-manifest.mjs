import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const stateDir = join(root, "scripts", ".pack-state");
const pluginManifest = join(root, "paseo-plugin.json");
const packageManifest = join(root, "package.json");
const packageLock = join(root, "package-lock.json");
const shrinkwrap = join(root, "npm-shrinkwrap.json");
const pluginBackup = join(stateDir, "paseo-plugin.json");
const packageBackup = join(stateDir, "package.json");
const pluginTemp = join(stateDir, "paseo-plugin.json.tmp");
const packageTemp = join(stateDir, "package.json.tmp");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.pack-tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// npm publishes npm-shrinkwrap.json but not package-lock.json, so the package
// needs its own lock for the dependencies users install. It keeps only the
// production entries of the development lock.
function productionLock(lock) {
  const packages = {};
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") {
      const rootEntry = { ...entry };
      delete rootEntry.devDependencies;
      packages[path] = rootEntry;
      continue;
    }
    if (entry.dev) continue;
    if (entry.devOptional || !entry.resolved || !entry.integrity) {
      throw new Error(`Cannot lock ${path} for the package: expected a production entry with resolved and integrity.`);
    }
    packages[path] = entry;
  }
  return { ...lock, packages };
}

async function restore() {
  await rm(shrinkwrap, { force: true });
  const hasPluginBackup = await exists(pluginBackup);
  const hasPackageBackup = await exists(packageBackup);
  if (!hasPluginBackup && !hasPackageBackup) {
    await rm(stateDir, { recursive: true, force: true });
    return;
  }

  if (hasPluginBackup) {
    await copyFile(pluginBackup, pluginTemp);
    await rename(pluginTemp, pluginManifest);
  }
  if (hasPackageBackup) {
    await copyFile(packageBackup, packageTemp);
    await rename(packageTemp, packageManifest);
  }
  await rm(stateDir, { recursive: true, force: true });
}

async function prepare() {
  if (await exists(stateDir)) await restore();

  await mkdir(stateDir, { recursive: true });
  try {
    await copyFile(pluginManifest, pluginTemp);
    await copyFile(packageManifest, packageTemp);
    await rename(pluginTemp, pluginBackup);
    await rename(packageTemp, packageBackup);

    const plugin = JSON.parse(await readFile(pluginManifest, "utf8"));
    const pkg = JSON.parse(await readFile(packageManifest, "utf8"));
    const lock = JSON.parse(await readFile(packageLock, "utf8"));
    delete plugin.build;
    delete pkg.private;
    delete pkg.devDependencies;
    delete pkg.scripts;

    await atomicWrite(pluginManifest, `${JSON.stringify(plugin, null, 2)}\n`);
    await atomicWrite(packageManifest, `${JSON.stringify(pkg, null, 2)}\n`);
    await atomicWrite(shrinkwrap, `${JSON.stringify(productionLock(lock), null, 2)}\n`);
  } catch (error) {
    try {
      await restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Pack manifest preparation failed and automatic restoration was incomplete.");
    }
    throw error;
  }
}

const action = process.argv[2];
if (action === "prepare") {
  await prepare();
} else if (action === "restore") {
  await restore();
} else {
  throw new Error("Usage: node scripts/pack-manifest.mjs <prepare|restore>");
}
