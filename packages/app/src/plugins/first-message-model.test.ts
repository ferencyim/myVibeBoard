import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { selectFirstMessageModelResolver } from "./first-message-model";

function plugin(serverId: string, resolve?: () => Promise<null>): InstalledPlugin {
  return {
    serverId,
    firstMessageModelResolvers: resolve ? [{ resolve }] : [],
  } as unknown as InstalledPlugin;
}
describe("selectFirstMessageModelResolver", () => {
  it("selects only the requested host and preserves daemon defaults when none is registered", async () => {
    const resolve = async () => null;
    const plugins = [plugin("other", resolve), plugin("selected"), plugin("selected", resolve)];
    expect(selectFirstMessageModelResolver(plugins, "selected")).toBe(resolve);
    expect(
      await selectFirstMessageModelResolver(plugins, "selected")?.({ projectId: "project" }),
    ).toBeNull();
    expect(selectFirstMessageModelResolver(plugins, "missing")).toBeNull();
  });
  it("rejects multiple resolvers for one host", () => {
    const resolve = async () => null;
    expect(() =>
      selectFirstMessageModelResolver(
        [plugin("selected", resolve), plugin("selected", resolve)],
        "selected",
      ),
    ).toThrow("Multiple plugins");
  });
});
