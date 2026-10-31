import { lstat, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import pLimit from "p-limit";

const limit = pLimit(16);
const require = createRequire(import.meta.url);
export type CacheMetadata = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  kind: string;
  link?: string;
} | null;

type StatFunction = typeof lstat;

export function cacheMetadataPath(
  file: string,
  electron = Boolean(process.versions.electron),
): string {
  return (electron && /^(.+?\.asar)(?:[\\/]|$)/i.exec(file)?.[1]) || file;
}

// Electron's virtual asar entries receive process-specific timestamps. The archive
// itself is a real file and its metadata is stable between daemon processes.
export async function cacheMetadata(
  file: string,
  options?: { electron?: boolean; archiveStat?: StatFunction; archiveTargetStat?: StatFunction },
): Promise<CacheMetadata> {
  const electron = options?.electron ?? Boolean(process.versions.electron);
  const resolved = cacheMetadataPath(file, electron);
  const archive = resolved !== file || (electron && /\.asar$/i.test(file)) ? resolved : undefined;
  try {
    if (archive) {
      const archiveStat: StatFunction =
        options?.archiveStat ?? require("original-fs").promises.lstat;
      const s = await limit(() => archiveStat(archive));
      const target = s.isSymbolicLink()
        ? await limit(() =>
            (options?.archiveTargetStat ?? require("original-fs").promises.stat)(archive),
          )
        : s;
      return {
        size: target.size,
        mtimeMs: target.mtimeMs,
        ctimeMs: target.ctimeMs,
        kind: "asar",
        ...(s.isSymbolicLink() ? { link: `${s.size}:${s.mtimeMs}:${s.ctimeMs}` } : {}),
      };
    }
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
    // An unreadable archive must never turn into a successful null/null match.
    if (archive) throw error;
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
