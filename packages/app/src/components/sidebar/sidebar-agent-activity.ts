import { useCallback, useMemo, useState } from "react";
import { useFetchQueries } from "@/data/query";
import { fetchAgentTimelineOnce } from "@/timeline/fetch-agent-timeline-once";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { planTimelineTailFetch, planTimelineOlderFetch } from "@/timeline/timeline-sync-plan";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import type { PluginSidebarAgentActivity } from "@getpaseo/plugin/client";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";

export function latestSidebarMessage(
  items: readonly StreamItem[],
): PluginSidebarAgentActivity["lastMessage"] {
  let latest: Extract<StreamItem, { kind: "user_message" | "assistant_message" }> | undefined;
  for (const item of items) {
    if (
      (item.kind === "user_message" || item.kind === "assistant_message") &&
      item.text.trim() &&
      (!latest || item.timestamp > latest.timestamp)
    )
      latest = item;
  }
  return latest ? { text: latest.text, timestamp: latest.timestamp.toISOString() } : undefined;
}

export function sidebarAgentActivity(
  agent: AggregatedAgent,
  items: readonly StreamItem[] = [],
): PluginSidebarAgentActivity {
  let status: PluginSidebarAgentActivity["status"];
  if (agent.attentionReason === "permission" || (agent.pendingPermissionCount ?? 0) > 0)
    status = "waiting";
  else if (agent.status === "error" || agent.attentionReason === "error") status = "failed";
  else if (agent.turn.phase === "open" || agent.status === "running") status = "working";
  else if (agent.requiresAttention && agent.attentionReason === "finished") status = "responded";
  return { agentId: agent.id, status, lastMessage: latestSidebarMessage(items) };
}

let activePreviewFetches = 0;
const previewWaiters: Array<() => void> = [];
export async function fetchPreview(
  client: DaemonClient,
  agentId: string,
): Promise<PluginSidebarAgentActivity["lastMessage"] | null> {
  if (activePreviewFetches >= 4) await new Promise<void>((resolve) => previewWaiters.push(resolve));
  else activePreviewFetches += 1;
  try {
    let request:
      | ReturnType<typeof planTimelineTailFetch>
      | ReturnType<typeof planTimelineOlderFetch> = planTimelineTailFetch();
    const seen = new Set<string>();
    for (;;) {
      const page = await fetchAgentTimelineOnce(client, agentId, request);
      if (page.error) throw new Error(page.error);
      for (const entry of page.entries.toReversed()) {
        const item = entry.item;
        if (
          (item.type === "user_message" || item.type === "assistant_message") &&
          item.text.trim()
        ) {
          return { text: item.text, timestamp: entry.timestamp };
        }
      }
      if (!page.hasOlder || !page.startCursor) return null;
      const cursor = page.startCursor;
      const key = `${cursor.epoch}:${cursor.seq}`;
      if (seen.has(key)) return null;
      seen.add(key);
      request = planTimelineOlderFetch(cursor);
    }
  } finally {
    const next = previewWaiters.shift();
    if (next) next();
    else activePreviewFetches -= 1;
  }
}

export function useSidebarAgentActivity(serverId: string) {
  const { agents } = useAggregatedAgents();
  const session = useSessionStore((state) => state.sessions[serverId]);
  const [requested, setRequested] = useState<string[]>([]);
  const requestAgentPreview = useCallback(
    (agentId: string) => setRequested((ids) => (ids.includes(agentId) ? ids : [...ids, agentId])),
    [],
  );
  const hostAgents = useMemo(
    () => agents.filter((agent) => agent.serverId === serverId),
    [agents, serverId],
  );
  const queries = useFetchQueries(
    requested.map((agentId) => ({
      queryKey: ["sidebar-bot-preview", serverId, session?.clientGeneration, agentId],
      queryFn: () =>
        session?.client ? fetchPreview(session.client, agentId) : Promise.resolve(null),
      dataShape: "value" as const,
      staleTimeMs: 60000,
      refetchInterval: 60000,
      retry: false,
    })),
  );
  const activities = hostAgents.map((agent) => {
    const cached = sidebarAgentActivity(agent, [
      ...(session?.agentStreamTail.get(agent.id) ?? []),
      ...(session?.agentStreamHead.get(agent.id) ?? []),
    ]);
    const fetched = queries[requested.indexOf(agent.id)]?.data;
    if (fetched && (!cached.lastMessage || fetched.timestamp > cached.lastMessage.timestamp))
      cached.lastMessage = fetched;
    return cached;
  });
  return { agents: activities, requestAgentPreview };
}
