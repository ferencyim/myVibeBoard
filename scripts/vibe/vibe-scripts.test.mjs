import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkPlugins } from "./check-plugins.mjs";
import { defaultRepoRoot, paseoRangeFor } from "./lib.mjs";
import { createPlugin } from "./new-plugin.mjs";
import { syncShared } from "./sync-shared.mjs";

function put(root, relative, content) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function tempRoot() {
  const base = path.join(defaultRepoRoot(), ".dev/vibe-scripts-tests");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "fixture-"));
}

function fixtureRoot() {
  const root = tempRoot();
  put(root, "package.json", JSON.stringify({ version: "0.12.3" }));
  put(root, "plugins/vibe-shared/contract/model.ts", "export const A = 1;\r\n");
  put(root, "plugins/vibe-shared/contract/model.test.ts", "test only\n");
  put(root, "plugins/vibe-shared/sync/hlc.ts", "export const B = 2;\n");
  put(root, "plugins/vibe-shared/db/migrations/001.sql", "CREATE TABLE t (id INTEGER);\n");
  put(root, "plugins/vibe-shared/db/index.ts", "export const C = 3;\n");
  createPlugin({ root, name: "demo" });
  const pkgPath = path.join(root, "plugins/vibe-demo/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.vibe.shared = { shared: ["contract", "sync"], server: ["db"] };
  writeFileSync(pkgPath, JSON.stringify(pkg));
  return root;
}

test("paseoRangeFor pins the minor line", () => {
  assert.equal(paseoRangeFor("0.12.0"), ">=0.12.0 <0.13.0");
  assert.equal(paseoRangeFor("1.9.4-beta.1"), ">=1.9.0 <1.10.0");
});

test("sync-shared writes copies with banner, skips tests, then --check passes", () => {
  const root = fixtureRoot();
  assert.ok(syncShared({ root, check: true }).drift.length > 0);
  syncShared({ root });
  const model = readFileSync(
    path.join(root, "plugins/vibe-demo/shared/vibe/contract/model.ts"),
    "utf8",
  );
  assert.match(model, /^\/\/ GENERATED FROM plugins\/vibe-shared/);
  assert.ok(!model.includes("\r"));
  const sql = readFileSync(
    path.join(root, "plugins/vibe-demo/server/vibe/db/migrations/001.sql"),
    "utf8",
  );
  assert.match(sql, /^-- GENERATED FROM/);
  assert.ok(!existsSync(path.join(root, "plugins/vibe-demo/shared/vibe/contract/model.test.ts")));
  assert.deepEqual(syncShared({ root, check: true }).drift, []);
});

test("sync-shared keeps opted-in client components inside each consumer client tree", () => {
  const root = fixtureRoot();
  put(
    root,
    "plugins/vibe-shared/client/prompts/editor.tsx",
    'import { TextInput } from "@getpaseo/plugin/client/react-native";\n',
  );
  put(root, "plugins/vibe-shared/client/prompts/editor.test.tsx", "test only\n");
  for (const name of ["board", "master"]) {
    createPlugin({ root, name });
    put(
      root,
      `plugins/vibe-${name}/package.json`,
      JSON.stringify({ vibe: { shared: { client: ["prompts"] } } }),
    );
  }
  syncShared({ root });
  for (const name of ["board", "master"]) {
    const target = path.join(root, `plugins/vibe-${name}/client/vibe/prompts/editor.tsx`);
    assert.match(readFileSync(target, "utf8"), /GENERATED FROM plugins\/vibe-shared/);
    assert.ok(!existsSync(path.join(root, `plugins/vibe-${name}/shared/vibe/prompts/editor.tsx`)));
    assert.ok(
      !existsSync(path.join(root, `plugins/vibe-${name}/client/vibe/prompts/editor.test.tsx`)),
    );
  }
  assert.ok(!existsSync(path.join(root, "plugins/vibe-demo/client/vibe/prompts/editor.tsx")));
  assert.deepEqual(syncShared({ root, check: true }).drift, []);
  put(root, "plugins/vibe-master/client/vibe/prompts/stray.tsx", "extra\n");
  syncShared({ root });
  assert.ok(!existsSync(path.join(root, "plugins/vibe-master/client/vibe/prompts/stray.tsx")));
});

test("sync-shared --check reports changed, missing and extra files; write mode repairs them", () => {
  const root = fixtureRoot();
  syncShared({ root });
  const target = path.join(root, "plugins/vibe-demo/shared/vibe");
  writeFileSync(path.join(target, "contract/model.ts"), "// edited by hand\n");
  writeFileSync(path.join(target, "sync/hlc.ts"), "");
  put(root, "plugins/vibe-demo/shared/vibe/stray/file.ts", "x\n");
  const { drift } = syncShared({ root, check: true });
  assert.equal(drift.length, 3);
  assert.ok(
    drift.some((d) => d.startsWith("changed: plugins/vibe-demo/shared/vibe/contract/model.ts")),
  );
  assert.ok(drift.some((d) => d.startsWith("extra: plugins/vibe-demo/shared/vibe/stray/file.ts")));
  syncShared({ root });
  assert.deepEqual(syncShared({ root, check: true }).drift, []);
  assert.ok(!existsSync(path.join(target, "stray/file.ts")));
  assert.ok(existsSync(path.join(target, "stray"))); // Only unlink individual files; retain directories.
});

test("sync-shared tolerates CRLF checkouts of generated copies", () => {
  const root = fixtureRoot();
  syncShared({ root });
  const file = path.join(root, "plugins/vibe-demo/shared/vibe/sync/hlc.ts");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
  assert.deepEqual(syncShared({ root, check: true }).drift, []);
});

test("sync-shared never recreates the removed App replica generated directory", () => {
  const root = fixtureRoot();
  put(root, "packages/app/src/vibe/README.md", "x\n");
  syncShared({ root });
  assert.ok(!existsSync(path.join(root, "packages/app/src/vibe/generated")));
});

test("sync-shared is a no-op without consumers and errors on a missing source dir", () => {
  const empty = tempRoot();
  assert.deepEqual(syncShared({ root: empty, check: true }), { targets: 0, drift: [] });
  const root = fixtureRoot();
  put(
    root,
    "plugins/vibe-demo/package.json",
    JSON.stringify({ vibe: { shared: { shared: ["nope"] } } }),
  );
  assert.throws(() => syncShared({ root }), /Missing source directory/);
});

test("new-plugin scaffolds a manifest with the repo's Paseo range and refuses duplicates", () => {
  const root = fixtureRoot();
  const created = createPlugin({ root, name: "scheduler", client: true });
  assert.ok(created.includes("plugins/vibe-scheduler/index.client.tsx"));
  const manifest = JSON.parse(
    readFileSync(path.join(root, "plugins/vibe-scheduler/paseo-plugin.json"), "utf8"),
  );
  assert.equal(manifest.id, "vibe-scheduler");
  assert.equal(manifest.requirements.paseo, ">=0.12.0 <0.13.0");
  assert.throws(() => createPlugin({ root, name: "scheduler" }), /already exists/);
  assert.throws(() => createPlugin({ root, name: "Bad_Name" }), /must match/);
});

test("check-plugins flags a stale Paseo range", () => {
  const root = fixtureRoot();
  assert.deepEqual(checkPlugins(root).problems, []);
  put(root, "package.json", JSON.stringify({ version: "0.13.0" }));
  const { problems } = checkPlugins(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /vibe-demo.*>=0\.13\.0 <0\.14\.0/);
});

test("check-plugins flags a client bundle that reaches server/", () => {
  const root = fixtureRoot();
  put(
    root,
    "plugins/vibe-demo/index.client.tsx",
    'import type { T } from "./server/types";\nimport { Screen } from "./client/screen";\n',
  );
  put(root, "plugins/vibe-demo/client/screen.tsx", 'import { LIMIT } from "../shared/limits";\n');
  put(root, "plugins/vibe-demo/shared/limits.ts", "export const LIMIT = 1;\n");
  put(root, "plugins/vibe-demo/server/types.ts", "export type T = 1;\n");
  put(root, "plugins/vibe-demo/server/policy.ts", "export const P = 1;\n");
  assert.deepEqual(checkPlugins(root).problems, []);
  put(
    root,
    "plugins/vibe-demo/shared/limits.ts",
    'export { P as LIMIT } from "../server/policy";\n',
  );
  const { problems } = checkPlugins(root);
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /vibe-demo: client bundle imports server-only module server.policy\.ts/,
  );
});
