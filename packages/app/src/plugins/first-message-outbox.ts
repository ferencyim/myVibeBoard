import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import type { InstalledPlugin } from "./types";

/** Snapshot the installed owner with the intent so reconnects cannot change its destination. */
export function resolveFirstMessageOutboxOwner(
  plugins: readonly Pick<InstalledPlugin, "serverId" | "id" | "firstMessageOutboxOwners">[],
  serverId: string,
): { pluginId: string; initialRole: string } | undefined {
  const owners = plugins.filter(
    (plugin) => plugin.serverId === serverId && (plugin.firstMessageOutboxOwners?.length ?? 0) > 0,
  );
  if (owners.length > 1) throw new Error("多个插件声明接收新会话首消息，请仅启用一个后重试");
  const owner = owners[0];
  return owner
    ? { pluginId: owner.id, initialRole: owner.firstMessageOutboxOwners![0].initialRole }
    : undefined;
}

const FirstMessageOwnerSchema = z.object({
  owner: z.object({ pluginId: z.string().min(1), initialRole: z.string().min(1) }).nullable(),
});
const ownerStorageKey = (serverId: string) =>
  `paseo:first-message-owner:v1:${encodeURIComponent(serverId)}`;

async function loadFirstMessageOutboxOwner(serverId: string) {
  const stored = await AsyncStorage.getItem(ownerStorageKey(serverId));
  let value: unknown;
  try {
    value = stored ? JSON.parse(stored) : null;
  } catch {
    value = null;
  }
  return FirstMessageOwnerSchema.safeParse(value);
}

/** Persist routing metadata only; offline first messages never evaluate cached plugin code. */
export async function saveFirstMessageOutboxOwner(
  serverId: string,
  plugins: Parameters<typeof resolveFirstMessageOutboxOwner>[0],
  getPluginError?: (pluginId: string) => string | undefined,
): Promise<void> {
  const owner = resolveFirstMessageOutboxOwner(plugins, serverId);
  if (!owner && getPluginError) {
    const stored = await loadFirstMessageOutboxOwner(serverId);
    // A failed owner is absent from the installed catalog, not disabled by the user.
    if (stored.success && stored.data.owner && getPluginError(stored.data.owner.pluginId)) return;
  }
  await AsyncStorage.setItem(ownerStorageKey(serverId), JSON.stringify({ owner: owner ?? null }));
}

export async function resolveFirstMessageSubmissionOwner(input: {
  serverId: string;
  plugins: Parameters<typeof resolveFirstMessageOutboxOwner>[0];
  connected: boolean;
  catalogLoaded: boolean;
  catalogError?: string;
  pluginsSupported: boolean;
  getPluginError?: (pluginId: string) => string | undefined;
}): Promise<ReturnType<typeof resolveFirstMessageOutboxOwner>> {
  if (input.connected) {
    if (input.pluginsSupported && !input.catalogLoaded) {
      throw new Error(
        input.catalogError
          ? `插件加载失败：${input.catalogError}；首消息仍保留在草稿中，请在主机插件设置中处理后重试`
          : "插件尚未加载完成，请稍后重试；首消息仍保留在草稿中",
      );
    }
    const owner = resolveFirstMessageOutboxOwner(input.plugins, input.serverId);
    const stored = !owner ? await loadFirstMessageOutboxOwner(input.serverId) : undefined;
    const previousOwner = stored?.success ? stored.data.owner : undefined;
    const candidate = owner ?? previousOwner;
    const error = candidate ? input.getPluginError?.(candidate.pluginId) : undefined;
    if (error) {
      throw new Error(
        `首消息负责插件 ${candidate!.pluginId} 不可用：${error}；首消息仍保留在草稿中`,
      );
    }
    return owner;
  }
  const result = await loadFirstMessageOutboxOwner(input.serverId);
  if (!result.success) {
    throw new Error("尚未取得主机的首消息配置，请先联网一次；首消息仍保留在草稿中");
  }
  return result.data.owner ?? undefined;
}
