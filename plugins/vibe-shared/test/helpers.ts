import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll } from "vitest";
import { createVibeStore, migrateAll, openVibeDb, type VibeDb } from "../db";

const tempDirs: string[] = [];

export function makeTempDir(prefix = "vibe-shared-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  // Temp dirs only ever contain flat files (db, -wal, -shm, bundle): delete them one by one,
  // never recursively.
  for (const dir of tempDirs.splice(0)) {
    try {
      for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
      rmdirSync(dir);
    } catch {
      // best effort (Windows may still hold a handle)
    }
  }
});

export function openTestDb(): { db: VibeDb; path: string } {
  const path = join(makeTempDir(), "vibe.db");
  return { db: openVibeDb({ path }), path };
}

/** Fresh fully-migrated db plus a store with a controllable clock. */
export function setup(startMs = Date.parse("2026-01-01T00:00:00.000Z")) {
  const { db, path } = openTestDb();
  migrateAll(db);
  const clock = { ms: startMs };
  const store = createVibeStore(db, { now: () => new Date(clock.ms), deviceId: "dev-test" });
  return { db, path, store, clock, tick: (ms = 1000) => (clock.ms += ms) };
}

let workerBundle: Promise<string> | undefined;

/** Bundle test/workers/worker.ts once; returns the .mjs path. */
export function workerFile(): Promise<string> {
  workerBundle ??= (async () => {
    const outfile = join(makeTempDir("vibe-worker-"), "worker.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./workers/worker.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    return outfile;
  })();
  return workerBundle;
}

export async function runWorker(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const file = await workerFile();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", file, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
