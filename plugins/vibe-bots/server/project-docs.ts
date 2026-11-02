import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";

const LIMIT = 64 * 1024;
const MAX_FILES = 80;
const MAX_DEPTH = 3;
const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", "PRODUCT-REQUIREMENTS.md", "README.md"];

export interface ProjectDoc {
  path: string;
  content: string;
  totalBytes: number;
  truncated: boolean;
}

async function readDoc(root: string, path: string): Promise<ProjectDoc | null> {
  try {
    const full = join(root, path);
    const stat = await lstat(full);
    if (!stat.isFile()) return null;
    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, LIMIT));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { path: path.split(sep).join("/"), content: buffer.subarray(0, bytesRead).toString("utf8"), totalBytes: stat.size, truncated: stat.size > LIMIT };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function markdownUnder(root: string, dir: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await markdownUnder(root, path, depth + 1, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && found.length < MAX_FILES) found.push(path);
  }
}

/** The project's documentation: the root briefs plus every Markdown file under docs/. Read-only, size-capped. */
export async function readProjectDocs(projectRoot: string): Promise<ProjectDoc[]> {
  const root = await realpath(projectRoot);
  const paths = [...ROOT_FILES];
  await markdownUnder(root, "docs", 0, paths);
  const docs = await Promise.all(paths.map((path) => readDoc(root, path)));
  return docs.flatMap((doc) => (doc ? [doc] : []));
}

/** Documents of several projects at once; each path is prefixed by its project folder name. A broken root is skipped. */
export async function readAllProjectDocs(projectRoots: readonly string[]): Promise<ProjectDoc[]> {
  const groups = await Promise.all(projectRoots.map(async (root) => {
    try {
      return (await readProjectDocs(root)).map((doc) => ({ ...doc, path: `${basename(root)}/${doc.path}` }));
    } catch {
      return [];
    }
  }));
  return groups.flat();
}
