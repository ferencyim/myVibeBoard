import type { PaseoApi } from "@getpaseo/client";

/** The slice of the vibe store this module needs (keeps it testable with a plain object). */
export interface SessionLookup {
  sessions: { getByAgent(agentId: string): { cardId: string | null } | undefined };
}

const PAGE_LIMIT = 200;

/**
 * Provider (CLI) session id -> board card id, built from Paseo agents (persistence handle carries
 * the CLI session id) and vibe's agent_session rows (agent id -> card).
 */
export async function buildSessionMap(
  paseo: Pick<PaseoApi, "agents">,
  store: SessionLookup,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const res = await paseo.agents.list({ page: { limit: PAGE_LIMIT, cursor } });
    for (const { agent } of res.entries) {
      const cardId = store.sessions.getByAgent(agent.id)?.cardId;
      if (!cardId) continue;
      for (const sid of [
        agent.persistence?.sessionId,
        agent.persistence?.nativeHandle,
        agent.runtimeInfo?.sessionId,
      ]) {
        if (sid) map.set(sid, cardId);
      }
    }
    if (!res.pageInfo.hasMore || !res.pageInfo.nextCursor) break;
    cursor = res.pageInfo.nextCursor;
  }
  return map;
}
