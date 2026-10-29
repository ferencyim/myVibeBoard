import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { collectProjectSettingsSections } from "./project-sections";

function plugin(
  serverId: string,
  pluginId: string,
  sections: Array<[string, number?]>,
): Pick<InstalledPlugin, "serverId" | "id" | "projectSettingsSections"> {
  return {
    serverId,
    id: pluginId,
    projectSettingsSections: sections.map(([id, order]) => ({
      id,
      title: id,
      order,
      Component: () => null,
    })),
  };
}

describe("collectProjectSettingsSections", () => {
  it("filters hosts and sorts sections stably across plugins with zero as default", () => {
    const plugins = [
      plugin("selected", "first", [["late", 5], ["default"], ["equal", 1]]),
      plugin("other", "hidden", [["hidden", -10]]),
      plugin("selected", "second", [
        ["early", -1],
        ["equal-second", 1],
      ]),
    ];
    expect(
      collectProjectSettingsSections(plugins, "selected").map(({ section }) => section.id),
    ).toEqual(["early", "default", "equal", "equal-second", "late"]);
    expect(plugins[0]?.projectSettingsSections[0]?.id).toBe("late");
    expect(collectProjectSettingsSections(plugins, "missing")).toEqual([]);
  });
});
