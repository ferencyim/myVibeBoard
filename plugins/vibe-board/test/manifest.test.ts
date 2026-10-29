import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(join(pluginDir, file), "utf8"));

describe("plugin manifest", () => {
  // scripts/vibe/check-plugins.mjs requires every vibe plugin to declare the checkout's minor range;
  // the installer refuses anything else. Fork-only host APIs are gated at runtime instead.
  it("declares the checkout's paseo minor range", () => {
    const [major, minor] = read("../../package.json").version.split(".");
    expect(read("paseo-plugin.json").requirements.paseo).toBe(
      `>=${major}.${minor}.0 <${major}.${Number(minor) + 1}.0`,
    );
  });

  it("uses the vibe-board id and ships its entry points", () => {
    expect(read("paseo-plugin.json").id).toBe("vibe-board");
    expect(existsSync(join(pluginDir, "index.server.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "index.client.tsx"))).toBe(true);
  });
});
