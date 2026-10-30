import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useEffect } from "react";
import { useFetchQueries } from "@/data/query";
import {
  classificationCacheKey,
  rememberClassification,
  useClassificationCache,
} from "@/components/sidebar/sidebar-classification-cache";
import { useInstalledPlugins } from "@/plugins/registry";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { StatusIndicatorStatus } from "@/ui/status-indicator";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";

// Older installations can persist status grouping; the WP-139 tree is project-based.
export function sidebarTreeGroupMode(_storedMode: SidebarGroupMode): SidebarGroupMode {
  return "project";
}

export function sidebarTaskStatus(
  bucket: SidebarStateBucket | undefined,
): StatusIndicatorStatus | null {
  switch (bucket) {
    case "running":
      return "working";
    case "needs_input":
      return "waiting";
    case "failed":
      return "failed";
    case "attention":
      return "responded";
    default:
      return null;
  }
}

export interface SidebarWorkspaceClassification {
  workspaceId: string;
  kind: "task" | "bot";
  phaseLabel?: string;
  blockingReason?: string | null;
}

export function classifySidebarWorkspaces(
  workspaces: readonly SidebarWorkspacePlacement[],
  results: readonly { serverId: string; data?: readonly SidebarWorkspaceClassification[] }[],
) {
  const tasks: Array<{
    workspace: SidebarWorkspacePlacement;
    detail: SidebarWorkspaceClassification;
  }> = [];
  const other: SidebarWorkspacePlacement[] = [];
  const unknown: SidebarWorkspacePlacement[] = [];
  for (const workspace of workspaces) {
    const hostResults = results.filter((result) => result.serverId === workspace.serverId);
    const matches = hostResults.flatMap(
      (result) => result.data?.filter((item) => item.workspaceId === workspace.workspaceId) ?? [],
    );
    if (matches.some((item) => item.kind === "bot")) continue;
    const task = matches.find((item) => item.kind === "task");
    if (hostResults.length === 0 || hostResults.some((result) => result.data === undefined))
      unknown.push(workspace);
    else if (task) tasks.push({ workspace, detail: task });
    else other.push(workspace);
  }
  return { tasks, other, unknown };
}

export function useSidebarWorkspaceClassification(project: SidebarProjectEntry) {
  const plugins = useInstalledPlugins();
  const requests = project.hosts.flatMap((host) =>
    plugins
      .filter((plugin) => plugin.serverId === host.serverId)
      .flatMap((plugin) =>
        (plugin.sidebarWorkspaceProviders ?? []).map((provider) => ({ host, plugin, provider })),
      ),
  );
  const queries = useFetchQueries(
    requests.map(({ host, plugin, provider }) => {
      const workspaceIds = project.workspaces
        .filter((item) => item.serverId === host.serverId)
        .map((item) => item.workspaceId)
        .sort();
      return {
        queryKey: [
          "sidebar-workspace-projection",
          host.serverId,
          host.projectId,
          plugin.id,
          provider.id,
          workspaceIds,
        ],
        queryFn: () => provider.resolve({ projectId: host.projectId, workspaceIds }),
        dataShape: "list" as const,
        staleTimeMs: 30000,
        refetchInterval: 30000,
        retry: false,
      };
    }),
  );
  const cache = useClassificationCache();
  let loading = false;
  const results: { serverId: string; data?: readonly SidebarWorkspaceClassification[] }[] = [];
  const fresh: { key: string; data: readonly SidebarWorkspaceClassification[] }[] = [];
  for (const host of project.hosts) {
    const key = classificationCacheKey(host.serverId, host.projectId);
    const own = requests
      .map((request, index) => ({ request, query: queries[index] }))
      .filter(({ request }) => request.host === host);
    const answered = own.length > 0 && own.every(({ query }) => query?.data !== undefined);
    const data = answered ? own.flatMap(({ query }) => query?.data ?? []) : cache[key];
    if (answered) fresh.push({ key, data });
    else if (own.length > 0 && data === undefined)
      loading ||= own.some(({ query }) => query?.isPending);
    if (own.length > 0 || data !== undefined) results.push({ serverId: host.serverId, data });
  }
  // Content signature: the arrays above are rebuilt on every render.
  const freshSignature = JSON.stringify(fresh);
  useEffect(() => {
    for (const { key, data } of fresh) rememberClassification(key, data);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [freshSignature]);
  return { ...classifySidebarWorkspaces(project.workspaces, results), loading };
}

// An independent bot's main agent runs in `$VIBE_HOME/bots/<botId>`; the bot row stands for it.
const BOT_DIRECTORY = /(^|[\\/])bots[\\/]bot_[^\\/]+([\\/]|$)/;

function isBotWorkspace(workspace: SidebarWorkspacePlacement): boolean {
  return [workspace.workspaceDirectory, workspace.projectRootPath].some(
    (path) => path !== undefined && BOT_DIRECTORY.test(path),
  );
}

/** Drops independent bots' working directories, and the projects made only of them. */
export function hideIndependentBotWorkspaces(
  projects: readonly SidebarProjectEntry[],
): SidebarProjectEntry[] {
  return projects.flatMap((project) => {
    const workspaces = project.workspaces.filter((workspace) => !isBotWorkspace(workspace));
    if (workspaces.length === project.workspaces.length) return [project];
    return workspaces.length > 0 ? [{ ...project, workspaces }] : [];
  });
}
