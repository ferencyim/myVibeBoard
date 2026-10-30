import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoAgentCreateOptions, PaseoAgentSendOptions, PaseoProviderSnapshotResult } from "@getpaseo/client";
import { createBotService, type BotService } from "../server/service";
import { createBotMessaging } from "../server/messages";
import { appendTurnContext } from "../server/memory";
import { createVibeStore } from "../server/vibe/db/commands";
import { migrateOwner } from "../server/vibe/db/migrate";
import { openVibeDb, type VibeDb } from "../server/vibe/db/sqlite";

interface HostAgent {
  id: string;
  workspaceId: string;
  cwd: string;
  provider: string;
  model: string;
  thinkingOptionId: string | null;
  status: "idle" | "running" | "closed";
  labels: Record<string, string>;
  updatedAt: string;
  archivedAt: string | null;
}
const databases: VibeDb[] = [];
const services: BotService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllEnvs();
});

function fixture() {
  // Project bot tests never create directories. Keep migration away from the user's master state.
  vi.stubEnv("VIBE_HOME", join(tmpdir(), "wp138-service-" + randomUUID()));
  const db = openVibeDb({ path: ":memory:" });
  databases.push(db);
  migrateOwner(db, "vibe-bots");
  createVibeStore(db).prompts.register([{
    key: "project.agent.role", plugin: "vibe-board", role: "maintenance", title: "项目 bot", defaultText: "维护本项目并路由需求。",
  }]);
  const agents = new Map<string, HostAgent>();
  const setModel = vi.fn(async (id: string, model: string | null) => { agents.get(id)!.model = model ?? "initial"; });
  const setThinking = vi.fn(async (id: string, thinking: string | null) => { agents.get(id)!.thinkingOptionId = thinking; });
  const send = vi.fn(async (_id: string, _text: string, _options?: PaseoAgentSendOptions) => {});
  const setLabels = vi.fn(async (id: string, labels: Record<string, string>) => {
    const current = agents.get(id)!;
    if (current.archivedAt) throw new Error("归档 agent 不接受标签修改");
    current.labels = { ...current.labels, ...labels };
  });
  const setTitle = vi.fn(async (_id: string, _title: string) => {});
  function handle(id: string) {
    return {
      id,
      get workspaceId() { return agents.get(id)?.workspaceId ?? null; },
      get cwd() { return agents.get(id)?.cwd ?? null; },
      refresh: async () => agents.get(id) ?? null,
      current: () => agents.get(id) ?? null,
      setLabels: (labels: Record<string, string>) => setLabels(id, labels),
      setModel: (model: string | null) => setModel(id, model),
      setThinkingOption: (thinking: string | null) => setThinking(id, thinking),
      setMode: async (_mode: string) => {},
      setTitle: (title: string) => setTitle(id, title),
      send: (text: string, options?: PaseoAgentSendOptions) => send(id, text, options),
      resume: async () => { agents.get(id)!.status = "idle"; },
    };
  }
  const createAgent = vi.fn(async (input: PaseoAgentCreateOptions) => {
    const slash = input.config.provider.indexOf("/");
    const id = "agent-" + (agents.size + 1);
    agents.set(id, {
      id, workspaceId: "project-root", cwd: input.cwd ?? "/project-repo", provider: input.config.provider.slice(0, slash), model: input.config.provider.slice(slash + 1),
      thinkingOptionId: input.config.thinkingOptionId ?? null, status: "idle", labels: input.labels ?? {},
      updatedAt: "2026-10-29T00:00:00.000Z", archivedAt: null,
    });
    return handle(id);
  });
  const invoke = vi.fn(async (pluginId: string, method: string, _input: unknown) => {
    if (pluginId === "vibe-board" && method === "vibe.bot.handoff") return { text: "交接包：未决问题与下一步" };
    throw new Error("非预期 RPC：" + method);
  });
  const api = {
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/project-repo" }] }) },
    agents: {
      ref: handle,
      create: createAgent,
      list: async (options?: { filter?: { includeArchived?: boolean } }) => ({
        entries: [...agents.values()].filter(agent => options?.filter?.includeArchived || !agent.archivedAt).map(agent => ({ agent })),
        pageInfo: { nextCursor: null },
      }),
    },
    plugins: { invoke },
    providers: {
      refresh: vi.fn(async (_options?: unknown) => ({})),
      listAvailable: vi.fn(async () => ({ providers: [{ provider: "codex", available: true }, { provider: "claude", available: true }] })),
      listModels: vi.fn(async (_provider: string) => ({ models: [
        { id: "initial", label: "初始模型", isDefault: true, thinkingOptions: [{ id: "high", label: "高" }] },
        { id: "replacement", label: "替换模型", isDefault: false, thinkingOptions: [{ id: "high", label: "高" }] },
      ] })),
      listModes: vi.fn(async (_provider: string) => ({ modes: [{ id: "accept-edits", label: "允许编辑" }] })),
      snapshot: vi.fn(async (_options?: unknown): Promise<PaseoProviderSnapshotResult> => ({
        generatedAt: "2026-10-29T00:00:00.000Z", requestId: "cached-models",
        entries: ["codex", "claude"].map(provider => ({
          provider, enabled: true, status: "ready" as const,
          models: [
            { provider, id: "initial", label: "初始模型", isDefault: true, thinkingOptions: [{ id: "high", label: "高" }] },
            { provider, id: "replacement", label: "替换模型", isDefault: false, thinkingOptions: [{ id: "high", label: "高" }] },
          ],
          modes: [{ id: "accept-edits", label: "允许编辑" }],
        })),
      })),
    },
  };
  function start() {
    const service = createBotService(db, api);
    services.push(service);
    return service;
  }
  const service = start();
  const createProjectBot = () => service.create({ kind: "project", projectId: "p", name: "项目助理", provider: "codex", model: "initial" });
  function seedLegacy(id: string, labels: Record<string, string>) {
    agents.set(id, { id, workspaceId: "project-root", cwd: "/project-repo", provider: "codex", model: "initial", thinkingOptionId: "high", status: "idle", labels, updatedAt: "2026-10-28T00:00:00.000Z", archivedAt: null });
  }
  return { api, db, service, start, createProjectBot, agents, createAgent, setModel, setThinking, send, setLabels, setTitle, invoke, seedLegacy };
}

function modelIds(entry: { provider: string; models: Array<{ id: string }> }) {
  return [entry.provider, entry.models.map((model) => model.id)];
}

describe("bot 服务主对话与模型变更", () => {
  it("项目模型目录读取项目与全局缓存并保留全部可选模型", async () => {
    const f = fixture();
    f.api.providers.snapshot.mockImplementation(async (options) => ({
      generatedAt: "2026-10-29T00:00:00.000Z", requestId: "fixture",
      entries: (options as { cwd?: string })?.cwd ? [
        { provider: "claude", enabled: true, status: "ready", models: [
          { provider: "claude", id: "opus", label: "Opus", isDefault: true },
          { provider: "claude", id: "sonnet", label: "Sonnet", isDefault: false },
          { provider: "claude", id: "hidden", label: "Hidden", isSelectable: false },
        ] },
      ] : [{ provider: "codex", enabled: true, status: "ready", models: [
        { provider: "codex", id: "one", label: "One", isDefault: true },
        { provider: "codex", id: "two", label: "Two", isDefault: false },
      ] }],
    }));
    const result = await f.service.modelsForProject(undefined, "p");
    expect(result.providers.map(modelIds)).toEqual([
      ["codex", ["one", "two"]], ["claude", ["opus", "sonnet"]],
    ]);
    await f.service.modelsForProject(undefined, "p", true);
    expect(f.api.providers.refresh).toHaveBeenCalledWith({ cwd: "/project-repo" });
  });

  it("慢创建立即返回创建中，同 bot 单飞且同项目其他 bot 独立创建", async () => {
    const f = fixture();
    const one = await f.createProjectBot();
    const two = await f.createProjectBot();
    const create = f.createAgent.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.createAgent.mockImplementationOnce(async (input) => { await gate; return create(input); });
    try {
      const creating = { status: "creating", agentId: null, workspaceId: null, error: null };
      expect(await f.service.open(one.id)).toEqual(creating);
      expect(await f.service.open(one.id)).toEqual(creating);
      for (let attempt = 0; attempt < 100; attempt++) await Promise.resolve();
      expect(f.createAgent).toHaveBeenCalledTimes(1);
      expect(await f.service.state(one.id)).toEqual(creating);
      const other = await f.service.waitOpen(two.id);
      expect(f.createAgent).toHaveBeenCalledTimes(2);
      expect(await f.service.defaultBot("p")).toEqual({ botId: one.id, mainAgentId: null });
      release();
      const ready = await f.service.waitOpen(one.id);
      expect(ready.agentId).not.toBe(other.agentId);
      expect(await f.service.state(one.id)).toEqual({ status: "ready", ...ready, error: null });
      expect(f.createAgent).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });

  it("后台创建失败保留中文原因，状态轮询不重建，显式重试成功", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    f.createAgent.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await f.service.open(bot.id)).status).toBe("creating");
    let failed = await f.service.state(bot.id);
    for (let attempt = 0; attempt < 200 && failed.status === "creating"; attempt++) {
      await Promise.resolve();
      failed = await f.service.state(bot.id);
    }
    expect(failed).toMatchObject({ status: "failed", agentId: null, error: expect.stringContaining("创建") });
    expect(await f.service.state(bot.id)).toEqual(failed);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    const ready = await f.service.waitOpen(bot.id);
    expect(await f.service.state(bot.id)).toEqual({ status: "ready", ...ready, error: null });
    expect(f.createAgent).toHaveBeenCalledTimes(2);
    expect(f.createAgent.mock.calls[1][0]).toEqual(f.createAgent.mock.calls[0][0]);
  });

  it("打开只读缓存模型和权限目录，不启动慢 provider 探测", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    f.api.providers.listAvailable.mockClear().mockImplementation(() => new Promise(() => {}));
    f.api.providers.listModels.mockClear().mockImplementation(() => new Promise(() => {}));
    f.api.providers.listModes.mockClear().mockImplementation(() => new Promise(() => {}));
    expect((await f.service.open(bot.id)).status).toBe("creating");
    const ready = await f.service.waitOpen(bot.id);
    expect(await f.service.state(bot.id)).toEqual({ status: "ready", ...ready, error: null });
    expect(f.api.providers.snapshot).toHaveBeenCalledWith(expect.objectContaining({ cachedOnly: true }));
    expect(f.api.providers.listAvailable).not.toHaveBeenCalled();
    expect(f.api.providers.listModels).not.toHaveBeenCalled();
    expect(f.api.providers.listModes).not.toHaveBeenCalled();
  });

  it("创建资料不创建会话，首次并发打开只创建一次并复用主对话", async () => {
    const f = fixture();
    f.api.providers.listAvailable.mockImplementation(() => new Promise(() => {}));
    f.api.providers.listModels.mockImplementation(() => new Promise(() => {}));
    f.api.providers.listModes.mockImplementation(() => new Promise(() => {}));
    const bot = await f.createProjectBot();
    expect(bot.mainAgentId).toBeNull();
    expect(f.createAgent).not.toHaveBeenCalled();
    expect(f.api.providers.listAvailable).not.toHaveBeenCalled();
    expect(f.api.providers.listModels).not.toHaveBeenCalled();
    expect(f.api.providers.listModes).not.toHaveBeenCalled();
    const [first, concurrent] = await Promise.all([f.service.waitOpen(bot.id), f.service.waitOpen(bot.id)]);
    expect(first).toEqual(concurrent);
    expect(await f.service.waitOpen(bot.id)).toEqual(first);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.createAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project-repo", labels: { "vibe.bot": bot.id, "vibe.bot-thread": "main", "vibe.role": "project", "vibe.project_id": "p" } }));
    expect(f.service.bots.require(bot.id).mainAgentId).toBe(first.agentId);
  });

  it("缓存目录存在时拒绝未知模型", async () => {
    const f = fixture();
    await expect(f.service.create({ kind: "project", projectId: "p", name: "助理", provider: "codex", model: "unknown" }))
      .rejects.toThrow("未知模型");
    expect(f.createAgent).not.toHaveBeenCalled();
  });

  it("主对话归档后同 bot 重建，新的创建代次不复用旧幂等键", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const previous = await f.service.waitOpen(bot.id);
    f.agents.get(previous.agentId)!.archivedAt = "2026-10-29T01:00:00.000Z";
    expect((await f.service.open(bot.id)).status).toBe("creating");
    const rebuilt = await f.service.waitOpen(bot.id);
    expect(rebuilt.agentId).not.toBe(previous.agentId);
    expect(f.service.bots.require(bot.id).mainAgentId).toBe(rebuilt.agentId);
    expect(f.createAgent.mock.calls[1][0].idempotencyKey).not.toBe(f.createAgent.mock.calls[0][0].idempotencyKey);
    expect(f.agents.get(previous.agentId)?.archivedAt).toBe("2026-10-29T01:00:00.000Z");
    expect(f.invoke).toHaveBeenCalledWith("vibe-board", "vibe.bot.handoff", { agentId: previous.agentId });
    expect(f.createAgent.mock.calls[1][0].config.systemPrompt).toContain("交接包：未决问题与下一步");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("已有主 agent 时 open 立即返回 ready，不新建 agent", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.waitOpen(bot.id);
    for (let i = 0; i < 3; i++) {
      expect(await f.service.open(bot.id)).toEqual({ status: "ready", ...opened, error: null });
    }
    f.agents.get(opened.agentId)!.status = "closed";
    expect(await f.service.open(bot.id)).toMatchObject({ status: "ready", agentId: opened.agentId });
    expect(f.createAgent).toHaveBeenCalledTimes(1);
  });

  it("同 provider 换模型调用宿主 setModel，保留 bot、主会话、记忆与历史入口", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.waitOpen(bot.id);
    const memory = f.service.bots.memoryAdd(bot.id, "先解释原因", true);
    await f.service.update(bot.id, { model: "replacement", thinking: "high" });
    await f.service.apply(bot.id);
    const updated = f.service.view(f.service.bots.require(bot.id));
    expect(f.setModel).toHaveBeenCalledWith(opened.agentId, "replacement");
    expect(f.setThinking).toHaveBeenCalledWith(opened.agentId, "high");
    expect(updated).toMatchObject({ id: bot.id, mainAgentId: opened.agentId, provider: "codex", model: "replacement", thinking: "high", pendingModel: false });
    expect(updated.memories).toEqual([memory]);
    expect(await f.service.waitOpen(bot.id)).toEqual(opened);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("已关闭的主对话先恢复再换模型，保留原 agent", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.waitOpen(bot.id);
    f.agents.get(opened.agentId)!.status = "closed";
    await f.service.update(bot.id, { model: "replacement" });
    await f.service.apply(bot.id);
    const updated = f.service.view(f.service.bots.require(bot.id));
    expect(f.agents.get(opened.agentId)?.status).toBe("idle");
    expect(f.setModel).toHaveBeenCalledWith(opened.agentId, "replacement");
    expect(updated).toMatchObject({ mainAgentId: opened.agentId, provider: "codex", model: "replacement", pendingModel: false });
    expect(f.createAgent).toHaveBeenCalledTimes(1);
  });

  it("忙碌期间仅保存待应用设置，空闲后应用并清除 pending", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.waitOpen(bot.id);
    f.agents.get(opened.agentId)!.status = "running";
    expect(await f.service.update(bot.id, { model: "replacement" })).toMatchObject({ mainAgentId: opened.agentId, pendingModel: true });
    expect(f.setModel).not.toHaveBeenCalled();
    expect(await f.service.waitOpen(bot.id)).toEqual(opened);
    expect(f.setModel).not.toHaveBeenCalled();
    f.agents.get(opened.agentId)!.status = "idle";
    await f.service.apply(bot.id);
    expect(f.setModel).toHaveBeenCalledTimes(1);
    expect(f.setModel).toHaveBeenCalledWith(opened.agentId, "replacement");
    expect(f.service.bots.require(bot.id)).toMatchObject({ provider: "codex", model: "replacement", pendingModel: false });
  });

  it("换 provider 向 board 读取交接包，创建新主对话并保留旧会话和 bot 记忆", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const before = await f.service.waitOpen(bot.id);
    const memory = f.service.bots.memoryAdd(bot.id, "使用中文");
    await f.service.update(bot.id, { provider: "claude", model: "replacement" });
    await f.service.apply(bot.id);
    const updated = f.service.view(f.service.bots.require(bot.id));
    expect(f.invoke).toHaveBeenCalledWith("vibe-board", "vibe.bot.handoff", { agentId: before.agentId });
    expect(f.createAgent).toHaveBeenCalledTimes(2);
    expect(updated.mainAgentId).not.toBe(before.agentId);
    expect(updated).toMatchObject({ id: bot.id, pendingModel: false });
    expect(updated.memories).toEqual([memory]);
    expect(f.createAgent.mock.calls[1][0].config.systemPrompt).toContain("交接包：未决问题与下一步");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.agents.get(before.agentId)).toMatchObject({ provider: "codex", archivedAt: null });
    expect(f.agents.get(updated.mainAgentId!)).toMatchObject({ provider: "claude", labels: expect.objectContaining({ "vibe.bot": bot.id }) });
    expect((await f.service.waitOpen(bot.id)).agentId).toBe(updated.mainAgentId);
    expect(f.setModel).not.toHaveBeenCalled();
  });

  it("修改 provider 立即保存，后台创建不会阻塞更新", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const before = await f.service.waitOpen(bot.id);
    const updated = await f.service.update(bot.id, { provider: "claude", model: "replacement" });
    expect(updated).toMatchObject({ mainAgentId: before.agentId, pendingModel: true });
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    await f.service.apply(bot.id);
    expect(f.createAgent).toHaveBeenCalledTimes(2);
  });
});

it("真实旧总 agent 与项目 agent 无损迁移，重启不重复建 bot 且保留原会话和用户编辑", async () => {
  const f = fixture();
  f.seedLegacy("legacy-master", { role: "master", custom: "保留" });
  f.seedLegacy("legacy-project", { "vibe.role": "project", "vibe.project_id": "p", custom: "保留" });
  await f.service.ready();
  const master = f.service.bots.list({ kind: "independent" })[0]!;
  const project = f.service.bots.list({ projectId: "p" })[0]!;
  expect(master).toMatchObject({ kind: "independent", name: "总协调", mainAgentId: "legacy-master", thinking: "high" });
  expect(master.instructions).toContain("vibe_hub_status");
  expect(f.service.prompt(master)).toContain("你不自动派发");
  expect(f.service.prompt(master)).toContain("按需使用");
  expect(project).toMatchObject({ name: "项目 bot", mainAgentId: "legacy-project" });
  expect(f.setTitle).toHaveBeenCalledWith("legacy-master", "总协调");
  expect(f.setTitle).toHaveBeenCalledWith("legacy-project", "项目 bot");
  expect(await f.service.defaultBot("p")).toEqual({ botId: project.id, mainAgentId: "legacy-project" });
  expect(await f.service.waitOpen(master.id)).toEqual({ agentId: "legacy-master", workspaceId: "project-root" });
  expect(await f.service.waitOpen(project.id)).toEqual({ agentId: "legacy-project", workspaceId: "project-root" });
  await f.service.update(master.id, { name: "我的总助理", instructions: "保留说明" });
  expect(f.setTitle).toHaveBeenCalledWith("legacy-master", "我的总助理");
  const memory = f.service.bots.memoryAdd(master.id, "保留经验");
  await f.service.close();
  const restarted = f.start();
  await Promise.all([restarted.ready(), restarted.ready()]);
  expect(restarted.bots.list()).toHaveLength(2);
  expect(restarted.bots.require(master.id)).toMatchObject({ name: "我的总助理", instructions: "保留说明", mainAgentId: "legacy-master" });
  expect(restarted.bots.memories(master.id)).toEqual([memory]);
  expect(await restarted.defaultBot("p")).toEqual({ botId: project.id, mainAgentId: "legacy-project" });
  expect(f.agents.get("legacy-project")!.labels).toEqual({ "vibe.role": "project", "vibe.project_id": "p", custom: "保留", "vibe.bot": project.id, "vibe.bot-thread": "main" });
  expect(f.agents.get("legacy-master")!.labels).toEqual({ role: "master", custom: "保留", "vibe.bot": master.id, "vibe.bot-thread": "main" });
  expect(f.createAgent).not.toHaveBeenCalled();
});

it("归档的权威旧总 agent 在重启后补迁，打开时交接到新主对话", async () => {
  const f = fixture();
  f.seedLegacy("archived-master", { role: "master" });
  f.agents.get("archived-master")!.archivedAt = "2026-10-26T00:00:00.000Z";
  f.seedLegacy("newer-master", { role: "master" });
  const masterDir = join(process.env.VIBE_HOME!, "master");
  mkdirSync(masterDir, { recursive: true });
  writeFileSync(join(masterDir, "state.json"), JSON.stringify({ agent: { agentId: "archived-master" } }));
  await f.service.ready();
  const bot = f.service.bots.list({ kind: "independent" })[0]!;
  expect(bot).toMatchObject({ name: "总协调", mainAgentId: "archived-master" });
  expect(f.setLabels).not.toHaveBeenCalledWith("archived-master", expect.anything());
  expect(f.db.prepare("SELECT bot_id FROM bot_legacy_migration WHERE source='master'").get()).toEqual({ bot_id: bot.id });
  await f.service.update(bot.id, { name: "新助手" });
  expect(f.setTitle).not.toHaveBeenCalledWith("archived-master", "新助手");
  const opened = await f.service.waitOpen(bot.id);
  expect(opened.agentId).not.toBe("archived-master");
  expect(f.createAgent).toHaveBeenCalledWith(expect.objectContaining({ title: "新助手" }));
  expect(f.createAgent.mock.calls[0][0].config.systemPrompt).toContain("交接包：未决问题与下一步");
  expect(f.send).not.toHaveBeenCalled();
  await f.service.close();
  const restarted = f.start();
  await restarted.ready();
  expect(restarted.bots.list({ kind: "independent" })).toHaveLength(1);
  expect(restarted.bots.require(bot.id).mainAgentId).toBe(opened.agentId);
});


describe("个人记忆送达", () => {
  it("主对话创建和换 provider 重建都把已有记忆写入 system prompt", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    f.service.bots.memoryAdd(bot.id, "回答优先使用中文", true);
    const first = await f.service.waitOpen(bot.id);
    expect(f.createAgent.mock.calls[0][0].config.systemPrompt).toContain("回答优先使用中文");
    expect(f.service.memoryDelivery.prepare(bot.id, first.agentId, f.service.bots.memories(bot.id), [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))).toBeUndefined();
    await f.service.update(bot.id, { provider: "claude", model: "replacement" });
    await f.service.apply(bot.id);
    expect(f.createAgent.mock.calls[1][0].config.systemPrompt).toContain("回答优先使用中文");
    const agentId = f.service.bots.require(bot.id).mainAgentId!;
    expect(f.service.memoryDelivery.prepare(bot.id, agentId, f.service.bots.memories(bot.id), [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))).toBeUndefined();
  });

  it("下一回合只送新增修改删除，确认后不重送，重启保留已送达版本", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const keep = f.service.bots.memoryAdd(bot.id, "不变的条目");
    const edit = f.service.bots.memoryAdd(bot.id, "旧内容");
    const remove = f.service.bots.memoryAdd(bot.id, "将删除");
    const opened = await f.service.waitOpen(bot.id);
    f.service.bots.memoryAdd(bot.id, "新内容");
    f.service.bots.memoryUpdate(bot.id, edit.id, { text: "修改后" });
    f.service.bots.memoryRemove(bot.id, remove.id);
    const memories = f.service.bots.memories(bot.id);
    const delivery = f.service.memoryDelivery.prepare(bot.id, opened.agentId, memories, [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))!;
    expect(delivery.context).toContain("系统：你的个人记忆已更新");
    expect(delivery.context).toContain("新增 ");
    expect(delivery.context).toContain("新内容");
    expect(delivery.context).toContain("修改后");
    expect(delivery.context).toContain('删除 {"id":"' + remove.id);
    expect(delivery.context).not.toContain(keep.text);
    expect(delivery.context).not.toContain("将删除");
    expect(f.service.memoryDelivery.prepare(bot.id, opened.agentId, memories, [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))).toEqual(delivery);
    f.service.memoryDelivery.delivered(opened.agentId, delivery.deliveryId);
    expect(f.service.memoryDelivery.prepare(bot.id, opened.agentId, memories, [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))).toBeUndefined();
    const restarted = f.start();
    expect(restarted.memoryDelivery.prepare(bot.id, opened.agentId, memories, [restarted.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))).toBeUndefined();
  });

  it("不同 bot 隔离，超预算标注，错误收件人的确认不消耗差异", async () => {
    const f = fixture();
    const one = await f.createProjectBot();
    const two = await f.createProjectBot();
    const first = await f.service.waitOpen(one.id);
    const second = await f.service.waitOpen(two.id);
    f.service.bots.memoryAdd(one.id, "超长".repeat(4000), true);
    const delivery = f.service.memoryDelivery.prepare(one.id, first.agentId, f.service.bots.memories(one.id), f.service.prompt(one))!;
    expect(delivery.context).toContain("[记忆超出预算，已截断]");
    expect(delivery.context).toContain("不是用户消息");
    expect(f.service.memoryDelivery.prepare(two.id, second.agentId, f.service.bots.memories(two.id), f.service.prompt(two))).toBeUndefined();
    f.service.memoryDelivery.delivered(second.agentId, delivery.deliveryId);
    expect(f.service.memoryDelivery.prepare(one.id, first.agentId, f.service.bots.memories(one.id), f.service.prompt(one))).toEqual(delivery);
  });
});


it("旧调度提示词不迁入独立 bot，模型通知权限仍迁移", async () => {
  const f = fixture();
  f.seedLegacy("legacy-master", { role: "master" });
  f.invoke.mockResolvedValue({ presetId: null, candidateIndex: 0, backupModels: [{ provider: "claude", model: "replacement", thinking: "high" }], instructions: "按我写的角色说明回答", notifications: { enabled: false, completed: false, failed: true }, permissionMode: "full" } as never);
  await f.service.ready();
  await Promise.resolve();
  const bot = f.service.bots.list({ kind: "independent" })[0]!;
  expect(bot.name).toBe("总协调");
  expect(bot.instructions).toContain("vibe_hub_status");
  expect(bot).toMatchObject({
    provider: "codex", model: "initial", thinking: "high", permissionMode: "full",
    notifications: { enabled: false, completed: false, failed: true },
    backupModels: [{ provider: "claude", model: "replacement", thinking: "high" }],
  });
  expect(f.service.prompt(bot)).not.toContain("master.rules");
  expect(f.createAgent).not.toHaveBeenCalled();
});


it("旧主对话下一回合送达通用角色说明，用户修改说明后仅送新说明", async () => {
  const f = fixture();
  f.seedLegacy("legacy-helper", { role: "master" });
  await f.service.ready();
  const bot = f.service.bots.list({ kind: "independent" })[0]!;
  const role = [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n");
  const delivery = f.service.memoryDelivery.prepare(bot.id, "legacy-helper", [], role)!;
  expect(delivery.context).toContain("先前身份职责说明已撤销");
  expect(delivery.context).toContain("你不自动派发");
  expect(delivery.context).not.toContain("个人记忆已更新");
  f.service.memoryDelivery.delivered("legacy-helper", delivery.deliveryId);
  expect(f.service.memoryDelivery.prepare(bot.id, "legacy-helper", [], role)).toBeUndefined();
  const next = f.service.memoryDelivery.prepare(bot.id, "legacy-helper", [], "协助写作")!;
  expect(next.context).toContain("协助写作");
  expect(next.context).not.toContain("你不自动派发");
});

describe("旁线程", () => {
  it("支持增改归档并限制每个 bot 的未归档数量", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const other = await f.createProjectBot();
    const rows = Array.from({ length: 8 }, (_, i) => f.service.threads.create(bot.id, `话题 ${i}`));
    expect(() => f.service.threads.create(bot.id, "超限")).toThrow("8");
    expect(() => f.service.threads.rename(other.id, rows[0].id, "越权")).toThrow();
    expect(f.service.threads.rename(bot.id, rows[0].id, "新标题").title).toBe("新标题");
    f.service.threads.archive(bot.id, rows[0].id);
    expect(f.service.threads.list(bot.id)).toHaveLength(7);
    expect(f.service.threads.create(bot.id, "新话题")).toBeTruthy();
  });

  it("后台打开单飞，继承身份、目录和记忆，并校验调用者", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    f.service.bots.memoryAdd(bot.id, "共享记忆");
    const thread = f.service.threads.create(bot.id, "话题");
    const create = f.createAgent.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.createAgent.mockImplementationOnce(async (input) => { await gate; return create(input); });
    try {
      expect((await f.service.openThread(bot.id, thread.id)).status).toBe("creating");
      expect((await f.service.openThread(bot.id, thread.id)).status).toBe("creating");
      release();
      const opened = await f.service.waitThread(bot.id, thread.id);
      const request = f.createAgent.mock.calls[0][0];
      expect(request.cwd).toBe("/project-repo");
      expect(request.labels).toMatchObject({ "vibe.bot": bot.id, "vibe.bot-thread": thread.id });
      expect(request.config.systemPrompt).toContain("共享记忆");
      expect((await f.service.caller(opened.agentId)).id).toBe(bot.id);
      f.agents.get(opened.agentId)!.labels["vibe.bot"] = "other";
      await expect(f.service.caller(opened.agentId)).rejects.toThrow();
      expect(f.createAgent).toHaveBeenCalledTimes(1);
    } finally { release(); }
  });

  it("使用迁移主对话的目录，创建期间归档不会交付任务", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    f.seedLegacy("old-main", { "vibe.bot": bot.id, "vibe.bot-thread": "main" });
    f.agents.get("old-main")!.cwd = "/existing-directory";
    f.service.bots.setMain(bot.id, "old-main");
    const thread = f.service.threads.create(bot.id, "话题");
    const create = f.createAgent.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.createAgent.mockImplementationOnce(async (input) => { await gate; return create(input); });
    try {
      const opening = f.service.waitThread(bot.id, thread.id);
      for (let attempt = 0; attempt < 100 && !f.createAgent.mock.calls.length; attempt++) await Promise.resolve();
      expect(f.createAgent.mock.calls[0][0].cwd).toBe("/existing-directory");
      f.service.threads.archive(bot.id, thread.id);
      release();
      await expect(opening).rejects.toThrow("已归档");
      expect(f.service.threads.require(bot.id, thread.id).agentId).toBeTruthy();
      expect(f.send).not.toHaveBeenCalled();
    } finally { release(); }
  });
});

describe("总协调与 bot 消息", () => {
  const independent = (f: ReturnType<typeof fixture>, name: string) => f.service.create({ kind: "independent", name, provider: "codex", model: "initial" });

  it("助手迁移为总协调，重启幂等；用户改过的名字保留", async () => {
    const f = fixture();
    f.seedLegacy("master-1", { role: "master" });
    await f.service.ready();
    const coordinator = f.service.bots.coordinator()!;
    expect(coordinator).toMatchObject({ name: "总协调", title: "资源中枢与项目协调", role: "coordinator", mainAgentId: "master-1" });
    expect(coordinator.instructions).toContain("vibe_hub_status");
    const restarted = f.start();
    await restarted.ready();
    expect(restarted.bots.list({ kind: "independent" }).filter((bot) => bot.role === "coordinator")).toHaveLength(1);

    const g = fixture();
    const legacy = g.service.bots.legacy("master", { kind: "independent", name: "小明", instructions: "" }, null);
    expect(g.service.bots.ensureCoordinator(legacy.id, { name: "总协调", title: "t", instructions: "i" }))
      .toMatchObject({ name: "小明", role: "coordinator", title: "t" });
  });

  it("角色全局唯一、可转移，总协调不可归档", async () => {
    const f = fixture();
    const one = await independent(f, "甲");
    const two = await independent(f, "乙");
    f.service.bots.transferCoordinator(one.id);
    expect(() => f.service.bots.archive(one.id)).toThrow("总协调不能归档");
    expect(() => f.service.bots.transferCoordinator(one.id)).toThrow("已经是总协调");
    f.service.bots.transferCoordinator(two.id);
    expect(f.service.bots.coordinator()!.id).toBe(two.id);
    expect(f.service.bots.require(one.id).role).toBeNull();
    f.service.bots.archive(one.id);
    const project = await f.createProjectBot();
    expect(() => f.service.bots.transferCoordinator(project.id)).toThrow("独立 bot");
  });

  it("消息权限：项目 bot 只能发给总协调和同项目 bot", async () => {
    const f = fixture();
    const coordinator = await independent(f, "总");
    f.service.bots.transferCoordinator(coordinator.id);
    const other = await independent(f, "其它");
    const a = await f.createProjectBot();
    const b = await f.createProjectBot();
    const messaging = createBotMessaging(f.db, f.service, f.api);
    await expect(messaging.send(a, "coordinator", "hi")).resolves.toMatchObject({ status: "queued" });
    await expect(messaging.send(a, b.id, "hi")).resolves.toMatchObject({ status: "queued" });
    await expect(messaging.send(a, other.id, "hi")).rejects.toThrow("只能给总协调和本项目");
    await expect(messaging.send(a, { projectId: "p" }, "hi")).resolves.toMatchObject({ to: { botId: a.id === f.service.bots.defaultGet("p") ? a.id : f.service.bots.defaultGet("p") } }).catch(() => {});
    await expect(messaging.send(coordinator, other.id, "hi")).resolves.toMatchObject({ status: "queued" });
    await expect(messaging.send(a, a.id, "x")).rejects.toThrow("自己");
  });

  it("目标忙时排队，空闲后送达并标明发送方；系统消息经 notify", async () => {
    const f = fixture();
    const coordinator = await independent(f, "总");
    f.service.bots.transferCoordinator(coordinator.id);
    const a = await f.createProjectBot();
    const opened = await f.service.waitOpen(coordinator.id);
    f.agents.get(opened.agentId)!.status = "running";
    const messaging = createBotMessaging(f.db, f.service, f.api);
    await messaging.send(a, "coordinator", "磁盘快满了");
    await messaging.notify("coordinator", "中枢", "重任务排队超过 15 分钟");
    await messaging.flush(coordinator.id);
    expect(f.send).not.toHaveBeenCalled();
    f.agents.get(opened.agentId)!.status = "idle";
    await messaging.flush(coordinator.id);
    expect(f.send).toHaveBeenCalledTimes(1);
    const text = f.send.mock.calls[0][1];
    expect(text).toContain(`「${a.name}」(${a.id})`);
    expect(text).toContain("磁盘快满了");
    expect(text).toContain("[中枢] 重任务排队超过 15 分钟");
    await messaging.flush(coordinator.id);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("同一对 bot 10 分钟内超过 6 条即暂停投递并通知总协调", async () => {
    const f = fixture();
    const coordinator = await independent(f, "总");
    f.service.bots.transferCoordinator(coordinator.id);
    const a = await f.createProjectBot();
    const b = await f.createProjectBot();
    const messaging = createBotMessaging(f.db, f.service, f.api);
    for (let i = 0; i < 6; i++) await messaging.send(i % 2 ? a : b, i % 2 ? b.id : a.id, "来" + i);
    const held = await messaging.send(a, b.id, "第七条");
    expect(held.status).toBe("held");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM bot_message WHERE status='held'").get()).toMatchObject({ n: 1 });
    expect(f.db.prepare<{ text: string }>("SELECT text FROM bot_message WHERE to_bot_id=? AND from_bot_id IS NULL").get(coordinator.id)!.text).toContain("防循环");
    await messaging.send(b, a.id, "第八条");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM bot_message WHERE from_bot_id IS NULL").get()).toMatchObject({ n: 1 });
  });

  it("总协调可以查看并放行被防循环拦下的消息", async () => {
    const f = fixture();
    const coordinator = await independent(f, "总");
    f.service.bots.transferCoordinator(coordinator.id);
    const a = await f.createProjectBot();
    const b = await f.createProjectBot();
    const messaging = createBotMessaging(f.db, f.service, f.api);
    for (let i = 0; i < 6; i++) await messaging.send(i % 2 ? a : b, i % 2 ? b.id : a.id, "来" + i);
    expect((await messaging.send(a, b.id, "第七条")).status).toBe("held");
    expect(messaging.listHeld().map((row) => row.text)).toEqual(["第七条"]);
    expect(messaging.listHeld("nobody")).toEqual([]);
    await expect(messaging.releaseHeld(a.id)).resolves.toEqual({ released: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM bot_message WHERE status='held'").get()).toMatchObject({ n: 0 });
    await expect(messaging.releaseHeld()).resolves.toEqual({ released: 0 });
  });

  it("别的插件已写入 turn context 时追加而不覆盖，并沿用其送达 id", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.waitOpen(bot.id);
    f.service.bots.memoryAdd(bot.id, "新记忆");
    const instructions = [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n");
    const delivery = f.service.memoryDelivery.prepare(bot.id, opened.agentId, f.service.bots.memories(bot.id), instructions, "other-delivery")!;
    const merged = appendTurnContext({ agentId: opened.agentId, context: "全局指令块", deliveryId: "other-delivery" }, delivery);
    expect(merged.context!.startsWith("全局指令块\n\n")).toBe(true);
    expect(merged.context).toContain("新记忆");
    expect(merged.deliveryId).toBe("other-delivery");
    f.service.memoryDelivery.delivered(opened.agentId, "other-delivery");
    expect(f.service.memoryDelivery.prepare(bot.id, opened.agentId, f.service.bots.memories(bot.id), instructions)).toBeUndefined();
  });
});
