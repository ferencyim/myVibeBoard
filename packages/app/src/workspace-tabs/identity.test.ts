import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";
import { collapseTaskConversationDirectory } from "./conversation-directory";
import {
  collectAllTabs,
  createDefaultLayout,
  reconcileWorkspaceTabs,
  revealTargetInLayout,
} from "@/stores/workspace-layout-actions";

describe("task conversation identity", () => {
  it("restores anchor and member targets as one stable conversation", () => {
    let layout = createDefaultLayout();
    for (const agentId of ["anchor", "worker"]) {
      layout = revealTargetInLayout({
        layout,
        target: { kind: "agent", agentId },
        now: 1,
        placement: { mode: "focused" },
        explorerSidebarPaneId: null,
        createTabId: () => `agent_${agentId}`,
      })!.layout;
    }
    const restored = reconcileWorkspaceTabs(
      { layout, explorerSidebarPaneId: null },
      {
        agentsHydrated: true,
        terminalsHydrated: true,
        activeAgentIds: ["anchor", "worker"],
        autoOpenAgentIds: ["anchor", "worker"],
        standaloneTerminalIds: [],
        conversationByAgentId: new Map([
          ["anchor", "conversation-1"],
          ["worker", "conversation-1"],
        ]),
      },
    );
    const tabs = collectAllTabs(restored.layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0].target).toEqual({ kind: "task_conversation", conversationId: "conversation-1" });
  });
  it("keeps a durable identity independent of the current member", () => {
    const target = { kind: "task_conversation", conversationId: "conversation-1" } as const;
    expect(normalizeWorkspaceTabTarget({ ...target, conversationId: " conversation-1 " })).toEqual(
      target,
    );
    expect(buildDeterministicWorkspaceTabId(target)).toBe("task_conversation_conversation-1");
    expect(workspaceTabTargetsEqual(target, { ...target })).toBe(true);
    expect(normalizeWorkspaceTabTarget({ ...target, conversationId: " " })).toBeNull();
  });
  it("collapses task members to their anchor while preserving host isolation and ordinary rows", () => {
    const worker = {
      id: "worker",
      serverId: "host-1",
      taskConversationId: "task-1",
      labels: { "paseo.parent-agent-id": "anchor" },
    };
    const anchor = { id: "anchor", serverId: "host-1", taskConversationId: "task-1", labels: {} };
    const otherHost = { ...worker, serverId: "host-2" };
    const ordinary = { id: "ordinary", serverId: "host-1", labels: {} };
    expect(collapseTaskConversationDirectory([worker, ordinary, anchor, otherHost])).toEqual([
      anchor,
      ordinary,
      otherHost,
    ]);
  });
});

describe("New tab identity", () => {
  it("stays outside deterministic target identity", () => {
    const target = { kind: "new_tab" } as const;

    expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
    expect(workspaceTabTargetsEqual(target, target)).toBe(false);
    expect(() => buildDeterministicWorkspaceTabId(target)).toThrow(
      "New tabs do not have deterministic target identities",
    );
  });
});

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("working diff tab identity", () => {
  const target = {
    kind: "working_diff" as const,
    focusPath: "src/example.ts",
    focusRequestId: 1,
  };

  it("normalizes file focus navigation", () => {
    expect(
      normalizeWorkspaceTabTarget({
        ...target,
        focusPath: " src\\example.ts ",
      }),
    ).toEqual(target);
  });

  it("treats focus as navigation state rather than tab identity", () => {
    expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    expect(workspaceTabTargetsEqual(target, { ...target, focusPath: "src/other.ts" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { ...target, focusRequestId: 2 })).toBe(false);
    const workingDiffId = buildDeterministicWorkspaceTabId(target);
    const otherFocusId = buildDeterministicWorkspaceTabId({
      ...target,
      focusPath: "src/other.ts",
    });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: target.focusPath,
    });

    expect(workingDiffId).toBe("working_diff");
    expect(workingDiffId).toBe(otherFocusId);
    expect(workingDiffId).not.toBe(fileId);
  });
});

describe("workspace utility panel identity", () => {
  it.each(["files", "pull_request"] as const)(
    "normalizes and deterministically keys %s",
    (kind) => {
      const target = { kind };

      expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
      expect(buildDeterministicWorkspaceTabId(target)).toBe(kind);
      expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    },
  );
});

describe("commit diff tab identity", () => {
  it("keys a commit diff tab by its sha", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" })).toBe(
      "commit_diff_abc123",
    );
  });

  it("does not collide a commit diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "abc123",
    });
    expect(diffId).not.toBe(fileId);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "abc123" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "def456" },
      ),
    ).toBe(false);
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "abc123",
      }),
    ).toEqual({ kind: "commit_diff", sha: "abc123" });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "   ",
      }),
    ).toBeNull();
  });
});

describe("plugin panel tab identity", () => {
  it("normalizes exact workspace and agent context", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "plugin",
        pluginId: " review ",
        panelId: " details ",
        context: "agent",
        agentId: " agent-1 ",
      }),
    ).toEqual({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });
  });

  it("gives workspace and agent instances distinct stable ids", () => {
    const workspace = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "workspace",
    });
    const agent = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });

    expect(workspace).toBe("plugin_workspace_6_review_7_details");
    expect(agent).toBe("plugin_agent_6_review_7_details_7_agent-1");
  });
});
