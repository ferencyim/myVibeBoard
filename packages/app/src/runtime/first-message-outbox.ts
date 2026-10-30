import { randomUUID } from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { FirstMessageOutbox, type FirstMessageOutboxPort } from "@/composer/outbox/queue";
import { prepareOutboxAttachments } from "@/composer/outbox/attachments";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { fetchProvidersSnapshot } from "@/data/providers-snapshot";
import { normalizeWorkspaceDescriptor } from "@/stores/session-store";

import { getFirstMessageModelResolver, hasInstalledPluginCatalog } from "@/plugins/registry";

export const firstMessageOutbox = new FirstMessageOutbox({
  storage: AsyncStorage,
  requestId: () => randomUUID(),
});

function createOutboxPort(hostId: string, client: DaemonClient): FirstMessageOutboxPort {
  return {
    // COMPAT(taskFlowChoice): added in v0.13.2, remove after 2027-02-01.
    supportsFlowChoice: client.getLastServerInfoMessage()?.features?.taskFlowChoice === true,
    resolveDefaultConfig: async (entry) => {
      const resolver = getFirstMessageModelResolver(hostId);
      if (!resolver && !hasInstalledPluginCatalog(hostId)) return null;
      const cwd = entry.source.kind === "worktree" ? (entry.source.cwd ?? "") : "";
      const resolved = await resolver?.({ projectId: entry.projectId });
      if (resolved) return { ...resolved, cwd };
      const snapshot = await fetchProvidersSnapshot({ client, serverId: hostId, cwd: cwd || null });
      const available = snapshot.entries.find(
        (provider) => provider.enabled && provider.status === "ready",
      );
      if (!available) return null;
      const models =
        available.models?.filter((candidate) => candidate.isSelectable !== false) ?? [];
      const model = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (!model?.id.trim())
        throw new Error(
          "无法取得主机 provider 的默认模型，请到「任务角色」选择具体模型；首消息已保留",
        );
      return { provider: available.provider, model: model.id, cwd };
    },
    getCreation: (key) => client.getWorkspaceCreation(key),
    prepareAttachments: (entry) => prepareOutboxAttachments(entry),
    createWorkspace: async (input) => {
      if (!client.isConnected) throw new Error("主机已断线，首消息已保留");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("等待创建回执超时")), 30_000);
      });
      try {
        const result = await Promise.race([client.createWorkspace(input), timeout]);
        if (result.workspace) {
          const workspace = normalizeWorkspaceDescriptor(result.workspace);
          getHostRuntimeStore().acceptWorkspaceSnapshots(hostId, [workspace]);
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function flushFirstMessageOutbox(): Promise<void> {
  await firstMessageOutbox.hydrate();
  const store = getHostRuntimeStore();
  const hosts = store.getHosts();
  for (const host of hosts) {
    const snapshot = store.getSnapshot(host.serverId);
    const client = snapshot?.client;
    if (snapshot?.connectionStatus !== "online" || !client) continue;
    const pending = firstMessageOutbox
      .getSnapshot()
      .some(
        (entry) =>
          entry.hostId === host.serverId &&
          (entry.status === "queued" || entry.status === "unknown" || entry.status === "sending"),
      );
    if (!pending) continue;
    if (client.getLastServerInfoMessage()?.features?.creationLifecycle !== true) {
      await firstMessageOutbox.failUnsubmittedHost(
        host.serverId,
        "请升级目标主机后发送新任务；正文和附件已保留在本机",
      );
      continue;
    }
    await firstMessageOutbox.flushHost(host.serverId, createOutboxPort(host.serverId, client));
  }
}

export function startFirstMessageOutbox(): () => void {
  const store = getHostRuntimeStore();
  const flush = () => {
    void flushFirstMessageOutbox().catch((error) => {
      console.warn("[FirstMessageOutbox] 自动发送未完成", error);
    });
  };
  const stopRuntime = store.subscribeAll(flush);
  const stopHosts = store.subscribeHostList(flush);
  const stopOutbox = firstMessageOutbox.subscribe(flush);
  const timer = setInterval(flush, 5_000);
  flush();
  return () => {
    stopRuntime();
    stopHosts();
    stopOutbox();
    clearInterval(timer);
  };
}
