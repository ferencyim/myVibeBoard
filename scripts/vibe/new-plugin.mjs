// Scaffold a new vibe plugin: node scripts/vibe/new-plugin.mjs <name> [--client] [--root <dir>]
// Creates plugins/vibe-<name>/ with manifest (declaring the supported Paseo range), package.json
// (typecheck + test scripts, `vibe.shared` consumer declaration), tsconfig, vitest config, an
// empty server entry (and client entry with --client) and a manifest/compat test.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../is-main-module.mjs";
import { defaultRepoRoot, repoPaseoRange } from "./lib.mjs";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const titleCase = (name) =>
  name
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

const SERVER_ENTRY = `import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(_server: PluginServerContext) {
  return () => {};
}
`;

const CLIENT_ENTRY = `import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(_client: PluginClientContext) {
  return () => {};
}
`;

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

// Local config so the repo-root vitest.config.ts is not picked up.
export default defineConfig({});
`;

const MANIFEST_TEST = `import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(join(pluginDir, file), "utf8"));

describe("plugin manifest", () => {
  it("declares the Paseo range of this checkout (bump after each upstream merge)", () => {
    const [major, minor] = read("../../package.json").version.split(".");
    expect(read("paseo-plugin.json").requirements.paseo).toBe(
      \`>=\${major}.\${minor}.0 <\${major}.\${Number(minor) + 1}.0\`,
    );
  });

  it("has the entry points it ships", () => {
    expect(existsSync(join(pluginDir, "index.server.ts"))).toBe(true);
  });
});
`;

function files({ dir, name, client, paseoRange }) {
  const id = `vibe-${name}`;
  const entries = {
    "paseo-plugin.json": json({
      id,
      name: `Vibe ${titleCase(name)}`,
      description: `myVibeBoard ${name} plugin.`,
      requirements: { paseo: paseoRange },
    }),
    "package.json": json({
      name: `@vibe/${name}`,
      version: "0.1.0",
      private: true,
      description: `myVibeBoard ${name} plugin.`,
      license: "Apache-2.0",
      scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
      // Consumer declaration read by scripts/vibe/sync-shared.mjs. Add "contract"/"sync" under
      // `shared` and "db" under `server` as needed, then run the sync script.
      vibe: { shared: { shared: [], server: [] } },
      devDependencies: {
        "@getpaseo/client": "^0.12.0",
        "@getpaseo/plugin": "0.12.0",
        "@tanstack/react-query": "^5.90.11",
        "@types/node": "^24.19.2",
        "@types/react": "~19.2.0",
        react: "19.1.0",
        "react-native": "0.81.5",
        typescript: "^5.9.3",
        vitest: "^4.1.11",
        zod: "^4.4.3",
      },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2023"],
        types: ["react", "node"],
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules", "**/*.test.ts", "**/*.test.tsx"],
    }),
    "vitest.config.ts": VITEST_CONFIG,
    "index.server.ts": SERVER_ENTRY,
    "test/manifest.test.ts": MANIFEST_TEST,
    "README.md": `# ${id}\n\nmyVibeBoard plugin. Supported Paseo versions: see \`requirements.paseo\` in \`paseo-plugin.json\`.\n\n\`\`\`bash\nnpm install   # first time: creates package-lock.json (commit it)\nnpm run typecheck && npm test\n\`\`\`\n`,
  };
  if (client) entries["index.client.tsx"] = CLIENT_ENTRY;
  return Object.fromEntries(Object.entries(entries).map(([f, c]) => [path.join(dir, f), c]));
}

export function createPlugin({ root = defaultRepoRoot(), name, client = false }) {
  if (!NAME_PATTERN.test(name ?? "")) {
    throw new Error(
      `Plugin name must match ${NAME_PATTERN} (got "${name}"); the directory becomes plugins/vibe-<name>`,
    );
  }
  const dir = path.join(root, "plugins", `vibe-${name}`);
  if (existsSync(dir)) throw new Error(`${path.relative(root, dir)} already exists`);
  const created = files({ dir, name, client, paseoRange: repoPaseoRange(root) });
  for (const [file, content] of Object.entries(created)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return Object.keys(created).map((file) => path.relative(root, file).replaceAll("\\", "/"));
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const name = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--root");
  try {
    const created = createPlugin({
      root: rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : defaultRepoRoot(),
      name,
      client: args.includes("--client"),
    });
    console.log(created.join("\n"));
    console.log(`\nNext: cd plugins/vibe-${name} && npm install && npm run typecheck && npm test`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
