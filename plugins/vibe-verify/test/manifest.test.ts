import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => JSON.parse(readFileSync(join(pluginDir, file), "utf8"));

describe("plugin manifest", () => {
  it("declares the Paseo range of this checkout (bump after each upstream merge)", () => {
    const [major, minor] = read("../../package.json").version.split(".");
    expect(read("paseo-plugin.json").requirements.paseo).toBe(
      `>=${major}.${minor}.0 <${major}.${Number(minor) + 1}.0`,
    );
  });

  it("has the entry points it ships", () => {
    expect(existsSync(join(pluginDir, "index.server.ts"))).toBe(true);
  });
});
