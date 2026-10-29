import { describe, expect, it } from "vitest";
import { BotSnapshotCache } from "./bot-cache";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const memory = { id: "memory", botId: "bot_master", text: "偏好简洁", pinned: true };
const master = {
  id: "bot_master",
  kind: "independent",
  projectId: null,
  archivedAt: null,
  name: "助手",
  title: "",
  isDefault: false,
  memories: [memory],
};
const project = {
  id: "bot_project",
  kind: "project",
  projectId: "project",
  archivedAt: null,
  name: "项目 bot",
  isDefault: true,
  memories: [],
};

describe("bot and personal memory offline snapshots", () => {
  it("restores every bot and its memory after a cold start and isolates hosts", async () => {
    const disk = storage();
    const cache = new BotSnapshotCache(disk);
    await cache.received("host", { includeArchived: true }, { bots: [master, project] });
    const cold = new BotSnapshotCache(disk);
    await expect(cold.read("host", "vibe-master", "bots.list", {})).resolves.toEqual({
      bots: [master, project],
    });
    await expect(
      cold.read("host", "vibe-bots", "memories.list", { botId: master.id }),
    ).resolves.toEqual({ memories: [memory] });
    await expect(cold.read("other", "vibe-bots", "bots.list", {})).rejects.toThrow("尚无 bot 缓存");
  });

  it("matches project proxy filters and merges partial refreshes without losing other bots", async () => {
    const cache = new BotSnapshotCache(storage());
    await cache.received("host", { includeArchived: true }, { bots: [master, project] });
    const filter = cache.filter("vibe-board", { projectId: "project" });
    const renamed = { ...project, name: "新名字" };
    await cache.received("host", filter, { bots: [renamed] });
    await expect(cache.read("host", "vibe-board", "bots.list", {})).resolves.toEqual({
      bots: [renamed],
    });
    await expect(
      cache.read("host", "vibe-bots", "bots.list", { kind: "independent" }),
    ).resolves.toEqual({ bots: [master] });
    await cache.received("host", filter, { bots: [] });
    await expect(cache.read("host", "vibe-bots", "bots.list", {})).resolves.toEqual({
      bots: [master],
    });
  });

  it("hides archived bots by default and preserves them across active-list refreshes", async () => {
    const cache = new BotSnapshotCache(storage());
    const archived = { ...project, archivedAt: "2026-10-29T00:00:00Z" };
    await cache.received("host", { includeArchived: true }, { bots: [master, archived] });
    await cache.received("host", {}, { bots: [master] });
    await expect(cache.read("host", "vibe-bots", "bots.list", {})).resolves.toEqual({
      bots: [master],
    });
    await expect(
      cache.read("host", "vibe-bots", "bots.list", { includeArchived: true }),
    ).resolves.toEqual({ bots: [archived, master] });
    expect(cache.supports("vibe-bots", "memories.update")).toBe(false);
    expect(cache.supports("unrelated", "bots.list")).toBe(false);
  });

  it("recovers a malformed persisted snapshot on the next refresh", async () => {
    const disk = storage();
    disk.values.set("bot-snapshots:v1:host", "{");
    const cache = new BotSnapshotCache(disk);
    await expect(cache.read("host", "vibe-bots", "bots.list", {})).rejects.toThrow("尚无 bot 缓存");
    await cache.received("host", {}, { bots: [master] });
    await expect(cache.read("host", "vibe-bots", "bots.list", {})).resolves.toEqual({
      bots: [master],
    });
  });
});
