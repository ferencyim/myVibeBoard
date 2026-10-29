import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { createProjectAgentWorkspaceSelector } from "./sidebar-project-agent-workspaces";

function agent(
  workspaceId: string,
  role: string,
  parentAgentId: string | null = null,
): Pick<Agent, "workspaceId" | "labels" | "parentAgentId" | "archivedAt"> {
  return { workspaceId, labels: { "vibe.role": role }, parentAgentId };
}

describe("project agent workspace visibility", () => {
  it("hides project-only workspaces while retaining ordinary, mixed, and empty workspaces", () => {
    const select = createProjectAgentWorkspaceSelector();
    const sessions = {
      host: {
        agents: new Map([
          ["project", agent("project", "project")],
          ["ordinary", agent("ordinary", "main")],
          ["mixed-project", agent("mixed", "project")],
          ["mixed-ordinary", agent("mixed", "main")],
          ["child", agent("project", "", "project")],
        ]),
      },
    };
    expect([...select(sessions, ["host"])]).toEqual(["host:project"]);
  });

  it("uses directory snapshots without requiring loaded conversations and updates when agents change", () => {
    const select = createProjectAgentWorkspaceSelector();
    const agents = new Map([["project", agent("project", "project")]]);
    const hidden = select({ host: { agents } }, ["host"]);
    expect(select({ host: { agents } }, ["host"])).toBe(hidden);
    const mixed = new Map(agents);
    mixed.set("ordinary", agent("project", "main"));
    expect([...select({ host: { agents: mixed } }, ["host"])]).toEqual([]);
    expect([...select({ host: { agents } }, ["other"])]).toEqual([]);
  });

  it("keeps workspace identities isolated by host and ignores archived or child agents", () => {
    const select = createProjectAgentWorkspaceSelector();
    const sessions = {
      first: {
        agents: new Map([
          ["project", agent("shared-id", "project")],
          ["archived", { ...agent("shared-id", "main"), archivedAt: new Date("2026-01-01") }],
          [
            "archived-project",
            { ...agent("archived-only", "project"), archivedAt: new Date("2026-01-01") },
          ],
          ["child-project", agent("child-only", "project", "parent")],
        ]),
      },
      second: { agents: new Map([["ordinary", agent("shared-id", "main")]]) },
    };
    expect([...select(sessions, ["first", "second", "missing"])]).toEqual(["first:shared-id"]);
  });
});
