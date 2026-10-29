import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "@/plugins/types";
import { collectSidebarGroups } from "./plugin-sidebar-groups-model";

function plugin(serverId: string, groups: { id: string; order: number }[]): InstalledPlugin {
  return { serverId, sidebarGroups: groups } as unknown as InstalledPlugin;
}

describe("collectSidebarGroups", () => {
  it("sorts contributions and filters by host without mixing installations", () => {
    const plugins = [
      plugin("a", [{ id: "late", order: 20 }]),
      plugin("b", [{ id: "first", order: 10 }]),
    ];
    expect(collectSidebarGroups(plugins, []).map(({ item }) => item.id)).toEqual(["first", "late"]);
    expect(collectSidebarGroups(plugins, ["a"]).map(({ plugin: owner }) => owner.serverId)).toEqual(
      ["a"],
    );
    expect(collectSidebarGroups(plugins, ["missing"])).toEqual([]);
  });
});
