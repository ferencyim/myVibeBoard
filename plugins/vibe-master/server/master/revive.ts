// Bring a recorded agent back after a daemon restart. The daemon closes every agent when it stops
// (the agent keeps its persisted conversation); the next use has to load it again before it can
// take a message, otherwise the owner ends up with a fresh agent and a broken conversation.

import type { MasterAgentHandle } from "../types";

/** True when the agent exists and can take a message: already loaded, or loaded back by `resume()`. */
export async function reviveAgent(agent: MasterAgentHandle): Promise<boolean> {
  try {
    const snapshot = (await agent.refresh()) as { agent?: { status?: string } | null } | null | undefined;
    if (snapshot == null) return false;
    // Hosts without `resume()` load a closed agent when the message arrives.
    if (snapshot.agent?.status === "closed" && agent.resume) await agent.resume();
    return true;
  } catch {
    return false;
  }
}
