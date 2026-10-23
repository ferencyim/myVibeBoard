import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { resolvePluginWorkspacePanel, isPluginConversationPanel } from "./resolution";
import { setPluginTaskConversationRecipients } from "./recipients";
import { taskConversationKey, useTaskConversationStore } from "@/task-conversations/store";
import { useTaskConversationSelectionStore } from "@/composer/task-conversation-selection";

function installed(): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    workspacePanels: [
      {
        id: "details",
        title: "Details",
        icon: "Scan",
        context: "workspace",
        locations: ["workspace"],
        Component: () => null,
      },
    ],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("plugin workspace panel resolution", () => {
  it("keeps an empty conversation panel separate from agent tab resolution", () => {
    const plugin = installed();
    const panel = {
      id: "task",
      title: "Task",
      icon: "Scan",
      context: "agent" as const,
      locations: ["conversation"] as const,
      Component: () => null,
    };
    plugin.workspacePanels.push(panel);
    expect(isPluginConversationPanel(panel)).toBe(true);
    expect(
      resolvePluginWorkspacePanel(plugin, {
        kind: "plugin",
        pluginId: "review",
        panelId: "task",
        context: "agent",
        agentId: "anchor",
      }),
    ).toBeNull();
  });

  it("lets the owning plugin supply recipients before an anchor exists and clears on unload", () => {
    const plugin = installed();
    useTaskConversationStore.getState().setConversation("host-1", {
      conversationId: "task",
      workspaceId: "workspace",
      ownerPluginId: "review",
      anchorAgentId: null,
      status: "active",
      epoch: "epoch",
      lastSeq: 0,
      members: [],
      createdAt: "now",
      updatedAt: "now",
    });
    const input = {
      workspaceId: "workspace",
      conversationId: "task",
      recipients: [
        {
          id: "planner",
          label: "规划",
          recipient: { role: "planner", config: { provider: "codex", cwd: "/project" } },
        },
      ],
    };
    setPluginTaskConversationRecipients("host-1", input, plugin);
    const key = taskConversationKey("host-1", "task");
    expect(useTaskConversationSelectionStore.getState().selections.get(key)?.recipient?.role).toBe(
      "planner",
    );
    expect(useTaskConversationStore.getState().conversations.get(key)?.members).toEqual([]);
    expect(() =>
      setPluginTaskConversationRecipients("host-1", { ...input, workspaceId: "other" }, plugin),
    ).toThrow("workspace is unavailable");
    expect(() =>
      setPluginTaskConversationRecipients("host-1", input, { ...plugin, id: "other" }),
    ).toThrow("another plugin");
    plugin.lifetime.abort();
    expect(useTaskConversationSelectionStore.getState().selections.has(key)).toBe(false);
  });
  it("resolves only the exact plugin, panel, and context", () => {
    const plugin = installed();
    expect(
      resolvePluginWorkspacePanel(plugin, {
        kind: "plugin",
        pluginId: "review",
        panelId: "details",
        context: "workspace",
      })?.title,
    ).toBe("Details");
    expect(
      resolvePluginWorkspacePanel(plugin, {
        kind: "plugin",
        pluginId: "review",
        panelId: "details",
        context: "agent",
        agentId: "agent-1",
      }),
    ).toBeNull();
  });

  it("returns unavailable after the installation disappears", () => {
    expect(
      resolvePluginWorkspacePanel(null, {
        kind: "plugin",
        pluginId: "review",
        panelId: "details",
        context: "workspace",
      }),
    ).toBeNull();
  });
});
