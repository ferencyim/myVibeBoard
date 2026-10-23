import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  pin?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
  conversationId?: string;
  isKnown?: boolean;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const agentTarget = deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId });
  const agentWorkspaceId = input.workspaceId ?? agentTarget.agentWorkspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId || agentTarget.isKnown === false) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: agentTarget.conversationId
      ? { kind: "task_conversation", conversationId: agentTarget.conversationId }
      : { kind: "agent", agentId: input.agentId },
    pin: input.pin,
  });
}
