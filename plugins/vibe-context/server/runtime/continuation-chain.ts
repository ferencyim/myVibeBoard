import type { AgentSession } from "../vibe/contract";

/** Rejected candidates remain in history; the accepted member must descend from this request. */
export function isTaskContinuationChain(
  old: AgentSession,
  next: AgentSession,
  getSession: (id: string) => AgentSession | undefined,
): boolean {
  const visited = new Set<string>();
  let current: AgentSession | undefined = next;
  for (let depth = 0; current && depth < 256; depth++) {
    if (
      visited.has(current.id) ||
      current.workspaceId !== old.workspaceId ||
      current.projectId !== old.projectId ||
      current.role !== old.role ||
      current.confirmedAt !== old.confirmedAt
    )
      return false;
    if (current.id === old.id) return depth > 0;
    visited.add(current.id);
    current = current.previousSessionId ? getSession(current.previousSessionId) : undefined;
  }
  return false;
}
