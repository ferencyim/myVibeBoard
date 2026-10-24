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

/** Persist routing metadata only; offline first messages never evaluate cached plugin code. */
export async function saveFirstMessageOutboxOwner(
  serverId: string,
  plugins: Parameters<typeof resolveFirstMessageOutboxOwner>[0],
): Promise<void> {
  const owner = resolveFirstMessageOutboxOwner(plugins, serverId);
  await AsyncStorage.setItem(ownerStorageKey(serverId), JSON.stringify({ owner: owner ?? null }));
}

export async function resolveFirstMessageSubmissionOwner(input: {
  serverId: string;
  plugins: Parameters<typeof resolveFirstMessageOutboxOwner>[0];
  connected: boolean;
  catalogLoaded: boolean;
  catalogError?: string;
  pluginsSupported: boolean;
}): Promise<ReturnType<typeof resolveFirstMessageOutboxOwner>> {
  if (input.connected) {
    if (input.pluginsSupported && !input.catalogLoaded) {
      throw new Error(
        input.catalogError
          ? `插件加载失败：${input.catalogError}；首消息仍保留在草稿中，请在主机插件设置中处理后重试`
          : "插件尚未加载完成，请稍后重试；首消息仍保留在草稿中",
      );
    }
    return resolveFirstMessageOutboxOwner(input.plugins, input.serverId);
  }
  const stored = await AsyncStorage.getItem(ownerStorageKey(input.serverId));
  let value: unknown;
  try {
    value = stored ? JSON.parse(stored) : null;
  } catch {
    value = null;
  }
  const result = FirstMessageOwnerSchema.safeParse(value);
  if (!result.success) {
    throw new Error("尚未取得主机的首消息配置，请先联网一次；首消息仍保留在草稿中");
  }
  return result.data.owner ?? undefined;
}

/** Failed enabled plugins cannot silently change a task's first message into an ordinary chat. */
export function assertFirstMessagePluginsReady(
  plugins: readonly { id: string; enabled: boolean; status: string }[],
): void {
  const unavailable = plugins.filter((plugin) => plugin.enabled && plugin.status !== "running");
  if (unavailable.length)
    throw new Error(`已启用插件尚未运行：${unavailable.map((plugin) => plugin.id).join("、")}`);
}
