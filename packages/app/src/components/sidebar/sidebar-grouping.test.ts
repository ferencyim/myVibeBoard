import { describe, expect, it } from "vitest";
import { groupSidebarItems, type SidebarGroupingItem } from "./sidebar-grouping";

function item(id: string, overrides: Partial<SidebarGroupingItem> = {}): SidebarGroupingItem {
  return { id, kind: "task", status: "idle", ...overrides };
}

describe("groupSidebarItems", () => {
  it("groups projects without empty headings and puts independent bots first and default bots before activity", () => {
    const items = [
      item("task", { projectId: "p", projectName: "项目", lastActivityAt: 100 }),
      item("default", { kind: "bot", projectId: "p", isDefaultBot: true, lastActivityAt: 1 }),
      item("bot", { kind: "bot" }),
      item("ordinary", { kind: "session" }),
    ];
    const groups = groupSidebarItems(items, "project");
    expect(groups.map((group) => group.title)).toEqual(["独立 bot", "项目", "其他"]);
    expect(groups[1].items.map((row) => row.id)).toEqual(["default", "task"]);
    expect(groupSidebarItems([], "project")).toEqual([]);
    expect(groupSidebarItems([items[0]], "project").map((group) => group.title)).toEqual(["项目"]);
  });

  it("uses local calendar boundaries across midnight for date groups", () => {
    const now = new Date(2026, 9, 29, 0, 5);
    const groups = groupSidebarItems(
      [
        item("today", { lastActivityAt: new Date(2026, 9, 29, 0, 0) }),
        item("yesterday", { lastActivityAt: new Date(2026, 9, 28, 23, 59) }),
        item("week", { lastActivityAt: new Date(2026, 9, 23, 0, 0) }),
        item("older", { lastActivityAt: new Date(2026, 9, 22, 23, 59) }),
      ],
      "date",
      now,
    );
    expect(groups.map((group) => [group.title, group.items[0].id])).toEqual([
      ["今天", "today"],
      ["昨天", "yesterday"],
      ["最近 7 天", "week"],
      ["更早", "older"],
    ]);
  });

  it("orders status groups and hides empty ones", () => {
    const groups = groupSidebarItems(
      [
        item("idle"),
        item("attention", { status: "needs_attention" }),
        item("running", { status: "running" }),
      ],
      "status",
    );
    expect(groups.map((group) => group.title)).toEqual(["需要你", "运行中", "空闲"]);
  });

  it("pins a 需要你 group first in project and date modes and removes its items from the other groups", () => {
    const now = new Date(2026, 9, 29, 12);
    const items = [
      item("a", { projectId: "p1", projectName: "P1", lastActivityAt: now }),
      item("b", {
        projectId: "p1",
        projectName: "P1",
        status: "needs_attention",
        lastActivityAt: now,
      }),
      item("c", { kind: "bot", status: "needs_attention", lastActivityAt: now }),
    ];
    const byProject = groupSidebarItems(items, "project", now);
    expect(summarize(byProject)).toEqual([
      ["需要你", ["b", "c"]],
      ["P1", ["a"]],
    ]);
    const byDate = groupSidebarItems(items, "date", now);
    expect(byDate.map((group) => group.title)).toEqual(["需要你", "今天"]);
    expect(byDate[1].items.map((i) => i.id)).toEqual(["a"]);
  });

  it("shows no 需要你 group when nothing needs attention", () => {
    expect(groupSidebarItems([item("a")], "date").map((group) => group.title)).not.toContain(
      "需要你",
    );
  });
});

function itemIds(group: { items: { id: string }[] }): string[] {
  return group.items.map((entry) => entry.id);
}

function summarize(groups: { title: string; items: { id: string }[] }[]): [string, string[]][] {
  return groups.map((group) => [group.title, itemIds(group)]);
}
