import { z } from "zod";
import type { DocumentStorage } from "@/projects/document-cache";

// Keep plugin-owned fields intact; the host only owns filtering and persistence.
const botSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["independent", "project"]),
    projectId: z.string().nullable(),
    archivedAt: z.string().nullable(),
    memories: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();
const snapshotSchema = z.object({ bots: z.array(botSchema) });
const filterSchema = z.object({
  kind: z.enum(["independent", "project"]).optional(),
  projectId: z.string().optional(),
  includeArchived: z.boolean().optional(),
});
type BotFilter = z.infer<typeof filterSchema>;
type CachedBot = z.infer<typeof botSchema>;

function matches(bot: CachedBot, filter: BotFilter) {
  return (
    (!filter.kind || bot.kind === filter.kind) &&
    (!filter.projectId || bot.projectId === filter.projectId) &&
    (filter.includeArchived || bot.archivedAt === null)
  );
}

export class BotSnapshotCache {
  private writes = new Map<string, Promise<unknown>>();

  constructor(private storage: DocumentStorage) {}

  private key(serverId: string) {
    return "bot-snapshots:v1:" + encodeURIComponent(serverId);
  }

  private async load(serverId: string) {
    const raw = await this.storage.getItem(this.key(serverId));
    if (!raw) return null;
    try {
      const parsed = snapshotSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // A damaged local snapshot must not block the next online refresh.
      return null;
    }
  }

  filter(pluginId: string, input: unknown): BotFilter {
    const filter = filterSchema.parse(input);
    if (pluginId === "vibe-board") return { ...filter, kind: "project" };
    return filter;
  }

  supports(pluginId: string, method: string) {
    const supportedPlugin = ["vibe-bots", "vibe-master", "vibe-board"].includes(pluginId);
    return supportedPlugin && (method === "bots.list" || method === "memories.list");
  }

  received(serverId: string, filter: BotFilter, response: unknown) {
    const snapshot = snapshotSchema.parse(response);
    const previous = this.writes.get(serverId) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        const current = await this.load(serverId);
        const retained = (current?.bots ?? []).filter((bot) => !matches(bot, filter));
        const incomingIds = new Set(snapshot.bots.map((bot) => bot.id));
        const bots = [...retained.filter((bot) => !incomingIds.has(bot.id)), ...snapshot.bots];
        return this.storage.setItem(this.key(serverId), JSON.stringify({ bots }));
      });
    this.writes.set(serverId, write);
    return write;
  }

  async read(serverId: string, pluginId: string, method: string, input: unknown) {
    await this.writes.get(serverId)?.catch(() => {});
    const snapshot = await this.load(serverId);
    if (!snapshot) throw new Error("[offline] 尚无 bot 缓存，请联网同步后重试");
    if (method === "bots.list") {
      const filter = this.filter(pluginId, input);
      return { bots: snapshot.bots.filter((bot) => matches(bot, filter)) };
    }
    const { botId } = z.object({ botId: z.string() }).parse(input);
    const bot = snapshot.bots.find((entry) => entry.id === botId);
    if (!bot) throw new Error("[offline] 尚无此 bot 的记忆缓存，请联网同步后重试");
    return { memories: bot.memories };
  }
}
