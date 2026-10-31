import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Model Electron's virtual archive with a directory for reads, and a separate
// real archive file for original-fs metadata. Changes to virtual entry metadata
// must not affect the archive fingerprint.
vi.mock("./cache-metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cache-metadata.js")>();
  return {
    ...actual,
    cacheMetadataPath: (file: string) => actual.cacheMetadataPath(file, true),
    cacheMetadata: (file: string) =>
      actual.cacheMetadata(file, {
        electron: true,
        archiveStat: ((archive: string) => lstat(`${archive}.fingerprint`)) as typeof lstat,
      }),
  };
});

import { readCachedBundle, writeCachedBundle } from "./compiler-cache.js";
import { createPluginImportReader } from "./compiler-imports.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("reuses a bundle across virtual asar metadata changes, but invalidates on archive replacement", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "plugin-asar-cache-"));
  const archive = path.join(root, "app.asar");
  const virtual = path.join(archive, "host.js");
  const archiveFingerprint = `${archive}.fingerprint`;
  const entry = path.join(root, "plugin.ts");
  await mkdir(archive);
  await writeFile(archiveFingerprint, "archive version one");
  await writeFile(virtual, "host one");
  await writeFile(entry, "export default 1");
  await writeCachedBundle(
    entry,
    "server",
    root,
    "cached bundle",
    new Set([virtual]),
    Date.now() + 10000,
  );
  const cacheDirectory = path.join(root, "cache", "plugin-bundles-v1");
  const cacheFiles = await readdir(cacheDirectory);
  expect(cacheFiles).toHaveLength(1);
  const cached = JSON.parse(await readFile(path.join(cacheDirectory, cacheFiles[0]), "utf8"));
  expect(cached.files[archive]).toEqual(expect.objectContaining({ kind: "asar" }));
  expect(Object.hasOwn(cached.files, virtual)).toBe(false);
  await writeFile(virtual, "different virtual size and timestamps");
  const hit = vi.fn();
  expect(await readCachedBundle(entry, "server", root, hit)).toBe("cached bundle");
  expect(hit).toHaveBeenCalledWith(expect.objectContaining({ hit: true }));
  const result = vi.fn();
  await writeFile(archiveFingerprint, "archive version two, with a different size");
  expect(await readCachedBundle(entry, "server", root, result)).toBeNull();
  expect(result).toHaveBeenCalledWith(
    expect.objectContaining({ hit: false, dependencyPath: archive }),
  );
});

it("reuses asar import parsing despite virtual stat changes and invalidates for archive changes", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "plugin-asar-imports-"));
  const archive = path.join(root, "app.asar");
  const file = path.join(archive, "source.ts");
  await mkdir(archive);
  await writeFile(`${archive}.fingerprint`, "archive one");
  await writeFile(file, 'import "original";');
  const reader = createPluginImportReader(root, root);
  expect(await reader.read(file)).toMatchObject([{ specifier: "original" }]);
  await writeFile(file, 'import "changed-virtual-entry";');
  expect(await reader.read(file)).toMatchObject([{ specifier: "original" }]);
  await writeFile(`${archive}.fingerprint`, "archive two with different size");
  expect(await reader.read(file)).toMatchObject([{ specifier: "changed-virtual-entry" }]);
  const [cache] = await readdir(path.join(root, "cache", "plugin-imports-v1"));
  expect(
    JSON.parse(await readFile(path.join(root, "cache", "plugin-imports-v1", cache), "utf8")).kind,
  ).toBe("asar");
});
