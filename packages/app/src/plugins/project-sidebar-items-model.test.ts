import { describe, expect, it } from "vitest";
import { collectProjectSidebarItems } from "./project-sidebar-items-model";

const item = { id: "agent", title: "Agent", Component: () => null };
describe("project sidebar contributions", () => {
  it("uses the preferred project host once and keeps fixed row order", () => {
    const plugins = [
      { id: "board", serverId: "a", projectSidebarItems: [item] },
      { id: "board", serverId: "b", projectSidebarItems: [item] },
      { id: "other", serverId: "b", projectSidebarItems: [{ ...item, order: -1 }] },
      { id: "foreign", serverId: "c", projectSidebarItems: [item] },
    ];
    const rows = collectProjectSidebarItems(
      plugins,
      [
        { serverId: "a", projectId: "pa" },
        { serverId: "b", projectId: "pb" },
      ],
      "b",
    );
    expect(rows.map(({ plugin, projectId }) => [plugin.id, plugin.serverId, projectId])).toEqual([
      ["other", "b", "pb"],
      ["board", "b", "pb"],
    ]);
  });
  it("does not fall through to another host while the selected host is offline", () => {
    expect(
      collectProjectSidebarItems(
        [{ id: "board", serverId: "a", projectSidebarItems: [item] }],
        [
          { serverId: "a", projectId: "pa" },
          { serverId: "b", projectId: "pb" },
        ],
        "b",
      ),
    ).toEqual([]);
  });
  it("does not expose contributions without a matching project host", () => {
    expect(collectProjectSidebarItems([{ id: "old", serverId: "a" }], [])).toEqual([]);
  });
});
