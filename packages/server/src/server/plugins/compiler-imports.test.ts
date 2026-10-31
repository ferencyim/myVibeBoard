import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPluginImportReader, warmPluginImports } from "./compiler-imports.js";

const previousHome = process.env.PASEO_HOME;
let root: string | undefined;
afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  if (root) await rm(root, { recursive: true, force: true });
});

it("warms authored modules without traversing node_modules", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "plugin-import-warm-"));
  await mkdir(path.join(root, "server", "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(root, "index.server.ts"), 'import "entry";');
  await writeFile(path.join(root, "server", "code.ts"), 'import "module";');
  await writeFile(
    path.join(root, "server", "node_modules", "dep", "index.ts"),
    'import "external";',
  );
  await warmPluginImports(root, root);
  const cache = await readdir(path.join(root, "cache", "plugin-imports-v1"));
  expect(cache).toHaveLength(2);
});

it("reuses cached imports and invalidates them when the source changes", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "plugin-import-cache-"));
  process.env.PASEO_HOME = root;
  const file = path.join(root, "index.ts");
  await writeFile(file, 'import "first";');
  const reader = createPluginImportReader(root);
  const [first, concurrent] = await Promise.all([
    reader.read(file),
    createPluginImportReader(root).read(file),
  ]);
  expect(first).toBe(concurrent);
  expect(first).toMatchObject([{ specifier: "first" }]);
  const cacheDir = path.join(root, "cache", "plugin-imports-v1");
  const [name] = await readdir(cacheDir);
  const cacheFile = path.join(cacheDir, name);
  const cached = JSON.parse(await readFile(cacheFile, "utf8"));
  cached.imports[0].specifier = "cached";
  await writeFile(cacheFile, JSON.stringify(cached));
  expect(await createPluginImportReader(root).read(file)).toMatchObject([{ specifier: "cached" }]);
  await writeFile(file, 'import "changed-source";');
  expect(await reader.read(file)).toMatchObject([{ specifier: "changed-source" }]);
  const metadata = await stat(file);
  await writeFile(file, 'import "another-value!";');
  await utimes(file, metadata.atime, new Date(metadata.mtimeMs + 1000));
  expect((await stat(file)).size).toBe(metadata.size);
  expect(await reader.read(file)).toMatchObject([{ specifier: "another-value!" }]);
  await writeFile(cacheFile, "invalid json");
  expect(await reader.read(file)).toMatchObject([{ specifier: "another-value!" }]);
});
