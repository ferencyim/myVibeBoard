import type { Agent } from "@/stores/session-store";

interface AgentSession {
  agents: ReadonlyMap<
    string,
    Pick<Agent, "workspaceId" | "archivedAt" | "parentAgentId" | "labels">
  >;
}

export function createProjectAgentWorkspaceSelector() {
  let previousSources: Array<AgentSession["agents"] | undefined> = [];
  let previousServerIds: readonly string[] = [];
  let hidden: ReadonlySet<string> = new Set();
  return (sessions: Record<string, AgentSession | undefined>, serverIds: readonly string[]) => {
    const sources = serverIds.map((id) => sessions[id]?.agents);
    const unchanged =
      serverIds.length === previousServerIds.length &&
      serverIds.every(
        (id, index) => id === previousServerIds[index] && sources[index] === previousSources[index],
      );
    if (unchanged) return hidden;
    previousServerIds = serverIds;
    previousSources = sources;
    const projectWorkspaces = new Set<string>();
    const ordinaryWorkspaces = new Set<string>();
    for (const serverId of serverIds) {
      for (const agent of sessions[serverId]?.agents.values() ?? []) {
        if (!agent.workspaceId || agent.archivedAt || agent.parentAgentId) continue;
        const key = `${serverId}:${agent.workspaceId}`;
        if (agent.labels["vibe.role"] === "project") projectWorkspaces.add(key);
        else ordinaryWorkspaces.add(key);
      }
    }
    for (const key of ordinaryWorkspaces) projectWorkspaces.delete(key);
    const sameWorkspaces =
      projectWorkspaces.size === hidden.size &&
      [...projectWorkspaces].every((key) => hidden.has(key));
    if (sameWorkspaces) return hidden;
    hidden = projectWorkspaces;
    return hidden;
  };
}
