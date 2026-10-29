import type { PluginClientContext } from "@getpaseo/plugin/client";
import { taskPanelRpc } from "../shared/task-tabs";

export function contributeTaskSidebarProjection(client: PluginClientContext) {
  let active = 0;
  const waiting: Array<() => void> = [];
  async function readPanel(workspaceId: string) {
    if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await client.rpc(taskPanelRpc, { workspaceId });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  return client.addSidebarWorkspaceProvider({
    id: "tasks",
    async resolve({ workspaceIds }) {
      const tasks: Array<{ workspaceId: string; kind: "task"; phaseLabel: string; blockingReason: string | null }> = [];
      // Project requests run sequentially; the shared limit also bounds concurrent projects.
      for (const workspaceId of workspaceIds) {
        const panel = await readPanel(workspaceId);
        if (panel.isTask) tasks.push({ workspaceId, kind: "task", phaseLabel: panel.phaseLabel, blockingReason: panel.blockingReason });
      }
      return tasks;
    },
  });
}
