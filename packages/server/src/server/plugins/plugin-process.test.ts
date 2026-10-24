import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { z } from "zod";
import { describeAgentToolInput } from "./plugin-process.js";

it("advertises a strict empty object schema for input-less agent tools", () => {
  const { input, inputSchema } = describeAgentToolInput({
    name: "vibe_probe",
    description: "Probe",
    handler: async () => undefined,
  });
  expect(inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  expect(input.safeParse({}).success).toBe(true);
});

it("serializes an agent tool input schema for the manifest", () => {
  const { inputSchema } = describeAgentToolInput({
    name: "vibe_open_tab",
    description: "Open a tab",
    input: z.object({ role: z.enum(["scout", "worker"]) }).strict(),
    handler: async () => undefined,
  });
  expect(inputSchema).toMatchObject({
    type: "object",
    properties: { role: { enum: ["scout", "worker"] } },
    required: ["role"],
    additionalProperties: false,
  });
});

it("keeps React out of the plugin host's runtime dependency graph", async () => {
  await expect(
    build({
      entryPoints: [
        fileURLToPath(new URL("./plugin-process.ts", import.meta.url)),
        "@getpaseo/plugin",
        "@getpaseo/plugin/server",
        "@getpaseo/plugin/server/provider",
        "@getpaseo/plugin/server/acp",
      ],
      outdir: "unused",
      conditions: ["source"],
      bundle: true,
      platform: "node",
      format: "esm",
      // Node evaluates re-exports even when the host only imports one helper.
      treeShaking: false,
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "no-react",
          setup(context) {
            context.onResolve(
              { filter: /^(react|react-dom|react-native|use-sync-external-store)(\/|$)/ },
              ({ path, importer }) => ({
                errors: [{ text: `React dependency ${path} imported by ${importer}` }],
              }),
            );
          },
        },
      ],
    }),
  ).resolves.toMatchObject({ errors: [] });
});

it("exposes CLI probes through the plugin host's server SDK", async () => {
  const { evaluateBundle } = await import("./bundle-evaluator.js");
  const setup = evaluateBundle(`(require) => ({ default: async () => {
    const { execCommand } = require("@getpaseo/plugin/server");
    const { stdout } = await execCommand(${JSON.stringify(process.execPath)}, ["-e", "process.stdout.write('plugin CLI ready')"]);
    if (stdout !== "plugin CLI ready") throw new Error("CLI output was lost");
  } })`);
  // This contribution uses no server context APIs; it exercises the host's real SDK binding.
  await expect(setup(undefined as never)).resolves.toBeUndefined();
});
