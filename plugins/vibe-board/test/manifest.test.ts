import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(join(pluginDir, file), "utf8"));

describe("plugin manifest", () => {
  it("requires this fork’s project sidebar and lifecycle APIs from 0.13.2", () => {
    const [major, minor] = read("../../package.json").version.split(".");
    const range = read("paseo-plugin.json").requirements.paseo;
    expect(range).toBe(">=0.13.2 <0.14.0");
    expect(range.endsWith(`<${major}.${Number(minor) + 1}.0`)).toBe(true);
  });

  it("uses the vibe-board id and ships its entry points", () => {
    expect(read("paseo-plugin.json").id).toBe("vibe-board");
    expect(existsSync(join(pluginDir, "index.server.ts"))).toBe(true);
    expect(existsSync(join(pluginDir, "index.client.tsx"))).toBe(true);
  });
});
