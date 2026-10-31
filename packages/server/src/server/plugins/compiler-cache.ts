import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";
import { resolvePaseoHome } from "../paseo-home.js";

const require = createRequire(import.meta.url);
const limit = pLimit(16);
const CACHE_VERSION = 1;
type Metadata = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  kind: string;
  link?: string;
} | null;
interface CachedBundle {
  version: number;
  bundle: string;
  files: Record<string, Metadata>;
}

async function metadata(file: string): Promise<Metadata> {
  try {
    const s = await limit(() => lstat(file));
    const target = s.isSymbolicLink() ? await limit(() => stat(file)) : s;
    return {
      size: target.size,
      mtimeMs: target.mtimeMs,
      ctimeMs: target.ctimeMs,
      kind: target.isDirectory() ? "d" : "f",
      ...(s.isSymbolicLink() ? { link: `${s.size}:${s.mtimeMs}:${s.ctimeMs}` } : {}),
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"
    )
      return null;
    throw error;
  }
}

function cacheFile(entry: string, target: string, home?: string): string {
  const key = createHash("sha256")
    .update(JSON.stringify([path.resolve(entry), target]))
    .digest("hex");
  return path.join(home ?? resolvePaseoHome(), "cache", "plugin-bundles-v1", `${key}.json`);
}

export async function readCachedBundle(
  entry: string,
  target: string,
  home?: string,
): Promise<string | null> {
  try {
    const cached = JSON.parse(
      await readFile(cacheFile(entry, target, home), "utf8"),
    ) as CachedBundle;
    if (
      cached.version !== CACHE_VERSION ||
      typeof cached.bundle !== "string" ||
      !cached.files ||
      typeof cached.files !== "object"
    )
      return null;
    const files = Object.entries(cached.files);
    if (!files.length) return null;
    const valid = await Promise.all(
      files.map(
        async ([file, expected]) =>
          JSON.stringify(await metadata(file)) === JSON.stringify(expected),
      ),
    );
    return valid.every(Boolean) ? cached.bundle : null;
  } catch {
    return null;
  }
}

// Create both cache directories before taking the build start timestamp. In
// particular, PASEO_HOME may itself be inside the plugin being compiled.
export async function prepareBundleCache(home?: string): Promise<void> {
  const cache = path.join(home ?? resolvePaseoHome(), "cache");
  await Promise.all(
    ["plugin-imports-v1", "plugin-bundles-v1"].map((name) =>
      mkdir(path.join(cache, name), { recursive: true }),
    ),
  ).catch(() => undefined);
}

// Track parent directory metadata as well: adding a previously absent higher-priority
// module or package changes resolution even if every previously read file is unchanged.
export async function writeCachedBundle(
  entry: string,
  target: string,
  home: string | undefined,
  bundle: string,
  dependencies: Set<string>,
  buildStartedAt: number,
): Promise<void> {
  try {
    dependencies.add(path.resolve(entry));
    dependencies.add(fileURLToPath(import.meta.url));
    dependencies.add(fileURLToPath(new URL("./compiler.js", import.meta.url)));
    dependencies.add(fileURLToPath(new URL("./compiler-imports.js", import.meta.url)));
    dependencies.add(fileURLToPath(new URL("./plugin-sdk-specifiers.js", import.meta.url)));
    dependencies.add(fileURLToPath(new URL("./compiler.ts", import.meta.url)));
    dependencies.add(fileURLToPath(new URL("./compiler-imports.ts", import.meta.url)));
    dependencies.add(fileURLToPath(new URL("./plugin-sdk-specifiers.ts", import.meta.url)));
    for (const name of [
      "typescript/package.json",
      "esbuild/package.json",
      "@getpaseo/plugin/server",
    ]) {
      dependencies.add(require.resolve(name));
    }
    for (const input of Array.from(dependencies)) {
      // Module resolution may change when a sibling with higher precedence is
      // added. Track source directories, but not every ancestor: those include
      // shared Temp and drive roots where unrelated activity is common.
      if (/\.[cm]?[jt]sx?$/.test(input)) dependencies.add(path.dirname(input));
      let directory = path.dirname(input);
      for (;;) {
        for (const name of [
          "package.json",
          "package-lock.json",
          "npm-shrinkwrap.json",
          "pnpm-lock.yaml",
          "yarn.lock",
          "tsconfig.json",
        ])
          dependencies.add(path.join(directory, name));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const files = Object.fromEntries(
      await Promise.all(
        [...dependencies].map(async (file) => [file, await metadata(file)] as const),
      ),
    );
    // A file changed while esbuild or the checker was reading it: never associate
    // the resulting bundle with its newer metadata. Conservative for future mtimes.
    if (
      Object.values(files).some(
        (value) => value && (value.mtimeMs >= buildStartedAt || value.ctimeMs >= buildStartedAt),
      )
    )
      return;
    const file = cacheFile(entry, target, home);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ version: CACHE_VERSION, bundle, files }));
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  } catch {
    // An unavailable cache never prevents compilation.
  }
}
