import { describe, expect, it } from "vitest";
import { collectSettingsSidebarScreens } from "./sidebar-model";

const Component = () => null;
function makeScreen(id: string, order?: number) {
  return { id, title: id, icon: "Settings", Component, order };
}

describe("settings sidebar plugin screens", () => {
  it("lists every screen for the selected host in stable declared order", () => {
    const plugins = [
      { id: "scheduler", serverId: "host", settingsScreens: [makeScreen("scheduler", -20)] },
      {
        id: "board",
        serverId: "host",
        settingsScreens: [makeScreen("preferences", -40), makeScreen("models", -50)],
      },
      { id: "master", serverId: "host", settingsScreens: [makeScreen("master", -30)] },
      { id: "maintain", serverId: "host", settingsScreens: [makeScreen("maintain", -10)] },
      { id: "other", serverId: "other", settingsScreens: [makeScreen("other", -100)] },
    ];
    const entries = collectSettingsSidebarScreens(plugins, "host");
    expect(entries.map(({ screen }) => screen.id)).toEqual([
      "models",
      "preferences",
      "master",
      "scheduler",
      "maintain",
    ]);
    expect(collectSettingsSidebarScreens(plugins.toReversed(), "host")).toEqual(entries);
    expect(collectSettingsSidebarScreens(plugins, null)).toEqual([]);
  });

  it("breaks equal orders by plugin and screen identity", () => {
    const plugins = [
      { id: "b", serverId: "host", settingsScreens: [makeScreen("a")] },
      { id: "a", serverId: "host", settingsScreens: [makeScreen("b"), makeScreen("a")] },
    ];
    expect(
      collectSettingsSidebarScreens(plugins, "host").map(
        ({ plugin, screen }) => plugin.id + "/" + screen.id,
      ),
    ).toEqual(["a/a", "a/b", "b/a"]);
  });
});
