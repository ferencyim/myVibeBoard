import type { PaseoApi } from "@getpaseo/client";
import type { UsageSessionLink } from "./vibe/db";

/** Only persisted role attribution is authoritative; ordinary native agents stay unassigned. */
export interface SessionLookup {
  sessions: {
    getByAgent(agentId: string):
      | {
          workspaceId: string | null;
          projectId?: string | null;
          role: string;
          currentProvider: string;
        }
      | undefined;
  };
  projectConfigs: { get(projectId: string): { id: string } | undefined };
}

const PAGE_LIMIT = 200;

function recordLink(
  links: Map<string, UsageSessionLink>,
  ambiguous: Set<string>,
  item: UsageSessionLink,
) {
  const key = JSON.stringify([item.provider, item.sessionId]);
  if (ambiguous.has(key)) return;
  const existing = links.get(key);
  if (existing && (existing.workspaceId !== item.workspaceId || existing.role !== item.role)) {
    links.delete(key);
    ambiguous.add(key);
    return;
  }
  links.set(key, { ...item, agentId: existing?.agentId ?? item.agentId });
}

async function resolveProject(
  paseo: Pick<PaseoApi, "workspaces">,
  store: SessionLookup,
  workspaceId: string | null,
  projectId?: string | null,
): Promise<string | null> {
  const nativeId =
    projectId ??
    (workspaceId ? (await paseo.workspaces.ref(workspaceId).refresh())?.projectId : null);
  return nativeId ? (store.projectConfigs.get(nativeId)?.id ?? nativeId) : null;
}

/** CLI session identities are provider scoped; continuation sessions retain their own event keys. */
export async function buildSessionMap(
  paseo: Pick<PaseoApi, "agents" | "workspaces">,
  store: SessionLookup,
): Promise<UsageSessionLink[]> {
  const links = new Map<string, UsageSessionLink>();
  const ambiguous = new Set<string>();
  const projects = new Map<string, string | null>();
  let cursor: string | undefined;
  for (;;) {
    const res = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: PAGE_LIMIT, cursor },
    });
    for (const { agent } of res.entries) {
      const session = store.sessions.getByAgent(agent.id);
      if (!session) continue;
      const workspaceId = session.workspaceId;
      const projectKey = JSON.stringify([workspaceId, session.projectId]);
      if (!projects.has(projectKey)) {
        projects.set(
          projectKey,
          await resolveProject(paseo, store, workspaceId, session.projectId),
        );
      }
      const provider = agent.persistence?.provider ?? session.currentProvider.split("/")[0];
      if (!provider) continue;
      for (const sessionId of [
        agent.persistence?.sessionId,
        agent.persistence?.nativeHandle,
        agent.runtimeInfo?.sessionId,
      ]) {
        if (!sessionId) continue;
        recordLink(links, ambiguous, {
          provider,
          sessionId,
          workspaceId,
          projectId: projects.get(projectKey) ?? null,
          role: session.role,
          agentId: agent.id,
        });
      }
    }
    if (!res.pageInfo.hasMore || !res.pageInfo.nextCursor) break;
    cursor = res.pageInfo.nextCursor;
  }
  return [...links.values()];
}
