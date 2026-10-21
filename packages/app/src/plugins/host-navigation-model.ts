import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import { isHttpUrl } from "@/utils/http-url";

interface HostNavigationOwner {
  browserAvailable: boolean;
  openAgent(input: { serverId: string; agentId: string }): void;
  openWorkspace(input: NavigateToWorkspaceInput): void;
  resolveWorkspace(input: { serverId: string; workspaceId: string }): string | null;
  createBrowser(input: { initialUrl: string }): { browserId: string };
  openPluginScreen?(input: {
    serverId: string;
    pluginId: string;
    screenId: string;
    params?: Record<string, string>;
  }): void;
  openPluginSettings?(input: { serverId: string; pluginId: string; screenId: string }): void;
}

/**
 * The cross-plugin members of `PluginSurfaceProps["navigation"]` (packages/plugin contracts). Restated
 * here so the app still type-checks while the plugin package's built declarations are stale.
 */
interface CrossPluginNavigation {
  readonly openPluginScreen?: (input: {
    readonly pluginId: string;
    readonly screenId: string;
    readonly params?: Record<string, string>;
  }) => void;
  readonly openPluginSettings?: (input: {
    readonly pluginId: string;
    readonly screenId: string;
  }) => void;
}

export function createPluginHostNavigation(
  serverId: string,
  owner: HostNavigationOwner,
): NonNullable<PluginSurfaceProps["navigation"]> & CrossPluginNavigation {
  return {
    openAgent: ({ agentId, serverId: targetServerId }) =>
      owner.openAgent({ serverId: targetServerId ?? serverId, agentId }),
    openWorkspace: ({ workspaceId, serverId: targetServerId }) =>
      owner.openWorkspace({ serverId: targetServerId ?? serverId, workspaceId }),
    openPluginScreen: owner.openPluginScreen
      ? (input) => owner.openPluginScreen!({ serverId, ...input })
      : undefined,
    openPluginSettings: owner.openPluginSettings
      ? (input) => owner.openPluginSettings!({ serverId, ...input })
      : undefined,
    openBrowser: owner.browserAvailable
      ? ({ url, workspaceId, serverId: targetServerId }) => {
          if (!isHttpUrl(url)) throw new Error("Only absolute HTTP(S) URLs are supported.");
          if (!workspaceId.trim()) throw new Error("workspaceId is required.");
          const destinationServerId = targetServerId ?? serverId;
          const destinationWorkspaceId = owner.resolveWorkspace({
            serverId: destinationServerId,
            workspaceId,
          });
          if (!destinationWorkspaceId)
            throw new Error("Workspace is unavailable on the requested host.");
          const { browserId } = owner.createBrowser({ initialUrl: url });
          owner.openWorkspace({
            serverId: destinationServerId,
            workspaceId: destinationWorkspaceId,
            target: { kind: "browser", browserId },
          });
        }
      : undefined,
  };
}
