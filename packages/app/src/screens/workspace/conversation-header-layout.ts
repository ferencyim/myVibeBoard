import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "./workspace-tabs-types";

export function showWorkspaceTabRow(
  tab: WorkspaceTabDescriptor | null,
  labels: Record<string, string> | undefined,
): boolean {
  return tab?.target.kind !== "agent" || !labels?.["vibe.bot"];
}

export function useShowWorkspaceTabRow(serverId: string, tab: WorkspaceTabDescriptor | null) {
  const agentId = tab?.target.kind === "agent" ? tab.target.agentId : null;
  const labels = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return agentId
      ? (session?.agents?.get(agentId)?.labels ?? session?.agentDetails?.get(agentId)?.labels)
      : undefined;
  });
  return showWorkspaceTabRow(tab, labels);
}
