import { describe, expect, it } from "vitest";
import { showWorkspaceTabRow } from "./conversation-header-layout";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

const agent: WorkspaceTabDescriptor = {
  key: "agent",
  tabId: "agent",
  kind: "agent",
  target: { kind: "agent", agentId: "agent" },
};

describe("workspace conversation tab row", () => {
  it("hides the workspace row for bot main and side threads", () => {
    expect(showWorkspaceTabRow(agent, { "vibe.bot": "bot", "vibe.bot-thread": "main" })).toBe(
      false,
    );
    expect(showWorkspaceTabRow(agent, { "vibe.bot": "bot", "vibe.bot-thread": "thread" })).toBe(
      false,
    );
  });

  it("keeps the task flow and ordinary workspace rows", () => {
    expect(showWorkspaceTabRow(agent, { "vibe.task_id": "task" })).toBe(true);
    expect(showWorkspaceTabRow(agent, {})).toBe(true);
    expect(showWorkspaceTabRow(null, undefined)).toBe(true);
  });
});
