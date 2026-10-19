// Copy plugins/vibe-shared into every consumer, or verify the copies have not drifted.
//   node scripts/vibe/sync-shared.mjs            write copies
//   node scripts/vibe/sync-shared.mjs --check    exit 1 if any copy differs (writes nothing)
//   --root <dir>                                 operate on another checkout (tests)
//
// Consumers: plugins/<p> whose package.json has `vibe.shared`
// ({ "shared": ["contract","sync"], "server": ["db"] }) get plugins/<p>/shared/vibe/<sub>
// and plugins/<p>/server/vibe/<sub>; packages/app/src/vibe/generated/<sub> (contract+sync)
// is synced once packages/app/src/vibe exists. Target roots are generated-only: any file
// in them that is not a copy is drift (and is removed in write mode).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isMainModule } from "../is-main-module.mjs";
import { defaultRepoRoot, listVibePlugins, SHARED_PACKAGE_DIR } from "./lib.mjs";

const BANNER = `GENERATED FROM ${SHARED_PACKAGE_DIR} — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)`;
const COMMENT_PREFIX = new Map([
  [".ts", "//"],
  [".tsx", "//"],
  [".js", "//"],
  [".mjs", "//"],
  [".cjs", "//"],
  [".sql", "--"],
]);
const APP_SUBDIRS = ["contract", "sync"];

const normalizeEol = (text) => text.replaceAll("\r\n", "\n");

function isExcluded(name) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || name === "node_modules" || name === "__tests__"
  );
}

function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function generatedContent(sourceFile) {
  const text = normalizeEol(readFileSync(sourceFile, "utf8"));
  const prefix = COMMENT_PREFIX.get(path.extname(sourceFile));
  return prefix ? `${prefix} ${BANNER}\n${text}` : text;
}

function planTargets(root) {
  const sourceRoot = path.join(root, SHARED_PACKAGE_DIR);
  const targets = [];
  const add = (targetDir, subdirs) => {
    const files = new Map();
    for (const sub of subdirs) {
      const sourceDir = path.join(sourceRoot, sub);
      if (!existsSync(sourceDir)) {
        throw new Error(
          `Missing source directory ${SHARED_PACKAGE_DIR}/${sub} (needed by ${path.relative(root, targetDir)})`,
        );
      }
      for (const relative of listFiles(sourceDir)) {
        files.set(
          `${sub}/${relative}`,
          generatedContent(path.join(sourceDir, ...relative.split("/"))),
        );
      }
    }
    targets.push({ dir: targetDir, files });
  };
  for (const plugin of listVibePlugins(root)) {
    const { shared, server } = plugin.pkg.vibe.shared ?? {};
    if (shared?.length) add(path.join(plugin.dir, "shared/vibe"), shared);
    if (server?.length) add(path.join(plugin.dir, "server/vibe"), server);
  }
  if (existsSync(path.join(root, "packages/app/src/vibe"))) {
    add(path.join(root, "packages/app/src/vibe/generated"), APP_SUBDIRS);
  }
  return targets;
}

function existingFiles(dir) {
  return existsSync(dir) ? new Set(listFiles(dir)) : new Set();
}

export function syncShared({ root = defaultRepoRoot(), check = false } = {}) {
  const drift = [];
  const targets = planTargets(root);
  for (const target of targets) {
    const rel = (file) => path.relative(root, path.join(target.dir, file)).replaceAll("\\", "/");
    const present = existingFiles(target.dir);
    for (const [file, content] of target.files) {
      const absolute = path.join(target.dir, ...file.split("/"));
      const actual = present.has(file) ? normalizeEol(readFileSync(absolute, "utf8")) : null;
      if (actual === content) continue;
      drift.push(`${actual === null ? "missing" : "changed"}: ${rel(file)}`);
      if (!check) {
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, content);
      }
    }
    for (const file of present) {
      if (target.files.has(file)) continue;
      drift.push(`extra: ${rel(file)}`);
      if (!check) removeFileAndEmptyParents(target.dir, file);
    }
  }
  return { targets: targets.length, drift };
}

function removeFileAndEmptyParents(base, file) {
  unlinkSync(path.join(base, ...file.split("/")));
  // rmdirSync only removes empty directories; stop at the first non-empty one.
  for (
    let dir = path.dirname(path.join(base, ...file.split("/")));
    dir !== base;
    dir = path.dirname(dir)
  ) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const check = args.includes("--check");
  try {
    const { targets, drift } = syncShared({
      root: rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : defaultRepoRoot(),
      check,
    });
    for (const line of drift) console.log(line);
    if (check && drift.length) {
      console.error(
        `vibe-shared copies have drifted (${drift.length}). Run: node scripts/vibe/sync-shared.mjs`,
      );
      process.exit(1);
    }
    console.log(
      check
        ? `OK: ${targets} target(s) in sync`
        : `Synced ${targets} target(s), ${drift.length} change(s)`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
