import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createPluginImportReader, warmPluginImports } from "./compiler-imports.js";

const gate = vi.hoisted(() => {
  let release!: () => void;
  let ready!: () => void;
  return {
    blocked: 0,
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready: new Promise<void>((resolve) => {
      ready = resolve;
    }),
    release: () => release(),
    mark: () => {
      if (++gate.blocked === 3) ready();
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const file = String(args[0]);
      if (file.includes("warm-plugin-") && file.endsWith(".ts")) {
        gate.mark();
        await gate.wait;
      }
      return Reflect.apply(actual.readFile, undefined, args);
    },
  };
});

it("leaves a read slot for compilation while three plugins prewarm", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-priority-"));
  try {
    const warming = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const directory = path.join(root, `warm-plugin-${index}`);
        await mkdir(path.join(directory, "server"), { recursive: true });
        await Promise.all(
          Array.from({ length: 3 }, (_value, file) =>
            writeFile(path.join(directory, "server", `${file}.ts`), 'import "warm";'),
          ),
        );
        return directory;
      }),
    );
    const pending = warming.map((directory) => warmPluginImports(directory, root));
    await gate.ready;
    const foreground = path.join(root, "foreground.ts");
    await writeFile(foreground, 'import "foreground";');
    expect(await createPluginImportReader(root, root).read(foreground)).toMatchObject([
      { specifier: "foreground" },
    ]);
    expect(gate.blocked).toBe(3);
    gate.release();
    await Promise.all(pending);
  } finally {
    gate.release();
    await rm(root, { recursive: true, force: true });
  }
});
