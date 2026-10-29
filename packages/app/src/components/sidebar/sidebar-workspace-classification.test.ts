import { describe, expect, it } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import {
  classifySidebarWorkspaces,
  sidebarTaskStatus,
  sidebarTreeGroupMode,
} from "./sidebar-workspace-classification";

function workspace(serverId: string, workspaceId: string): SidebarWorkspacePlacement {
  return {
    serverId,
    workspaceId,
    workspaceKey: `${serverId}:${workspaceId}`,
  } as SidebarWorkspacePlacement;
}

describe("sidebar workspace classification", () => {
  it("opens the project tree for an older saved grouping", () => {
    expect(sidebarTreeGroupMode("project")).toBe("project");
    expect(sidebarTreeGroupMode("status")).toBe("project");
  });
  it("uses host identity, excludes bot workspaces, and retains task details", () => {
    const workspaces = [workspace("a", "same"), workspace("b", "same"), workspace("a", "ordinary")];
    const result = classifySidebarWorkspaces(workspaces, [
      {
        serverId: "a",
        data: [
          { workspaceId: "same", kind: "task", phaseLabel: "执行", blockingReason: "等待资源" },
        ],
      },
      { serverId: "a", data: [] },
      { serverId: "b", data: [{ workspaceId: "same", kind: "bot" }] },
    ]);
    expect(result.tasks.map(({ workspace: item }) => item.workspaceKey)).toEqual(["a:same"]);
    expect(result.tasks[0]?.detail.blockingReason).toBe("等待资源");
    expect(result.other.map((item) => item.workspaceKey)).toEqual(["a:ordinary"]);
    expect(result.unknown).toEqual([]);
  });

  it("does not label pending or failed provider results as ordinary sessions", () => {
    const item = workspace("a", "task");
    expect(
      classifySidebarWorkspaces([item], [{ serverId: "a", data: [] }, { serverId: "a" }]).unknown,
    ).toEqual([item]);
    expect(classifySidebarWorkspaces([item], []).unknown).toEqual([item]);
    expect(
      classifySidebarWorkspaces(
        [item],
        [{ serverId: "a", data: [{ workspaceId: "task", kind: "task" }] }, { serverId: "a" }],
      ).tasks,
    ).toEqual([]);
  });

  it("uses actual activity rather than treating every blocking reason as user input", () => {
    expect(sidebarTaskStatus("needs_input")).toBe("waiting");
    expect(sidebarTaskStatus("running")).toBe("working");
    expect(sidebarTaskStatus("failed")).toBe("failed");
    expect(sidebarTaskStatus("attention")).toBe("responded");
    expect(sidebarTaskStatus("done")).toBeNull();
  });
});
