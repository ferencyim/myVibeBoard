import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaseoAgentCreateOptions, PaseoAgentSendOptions } from "@getpaseo/client";
import { createBotService, type BotService } from "../server/service";
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
    current.labels = { ...current.labels, ...labels };
  });
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
      setTitle: async (_title: string) => {},
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
      list: async () => ({ entries: [...agents.values()].map(agent => ({ agent })), pageInfo: { nextCursor: null } }),
    },
    plugins: { invoke },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }, { provider: "claude", available: true }] }),
      listModels: async (_provider: string) => ({ models: [
        { id: "initial", label: "初始模型", isDefault: true, thinkingOptions: [{ id: "high", label: "高" }] },
        { id: "replacement", label: "替换模型", isDefault: false, thinkingOptions: [{ id: "high", label: "高" }] },
      ] }),
      listModes: async (_provider: string) => ({ modes: [{ id: "accept-edits", label: "允许编辑" }] }),
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
  return { db, service, start, createProjectBot, agents, createAgent, setModel, setThinking, send, setLabels, invoke, seedLegacy };
}

describe("bot 服务主对话与模型变更", () => {
  it("创建资料不创建会话，首次并发打开只创建一次并复用主对话", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    expect(bot.mainAgentId).toBeNull();
    expect(f.createAgent).not.toHaveBeenCalled();
    const [first, concurrent] = await Promise.all([f.service.open(bot.id), f.service.open(bot.id)]);
    expect(first).toEqual(concurrent);
    expect(await f.service.open(bot.id)).toEqual(first);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.createAgent).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project-repo", labels: { "vibe.bot": bot.id, "vibe.bot-thread": "main", "vibe.role": "project", "vibe.project_id": "p" } }));
    expect(f.service.bots.require(bot.id).mainAgentId).toBe(first.agentId);
  });

  it("同 provider 换模型调用宿主 setModel，保留 bot、主会话、记忆与历史入口", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.open(bot.id);
    const memory = f.service.bots.memoryAdd(bot.id, "先解释原因", true);
    const updated = await f.service.update(bot.id, { model: "replacement", thinking: "high" });
    expect(f.setModel).toHaveBeenCalledWith(opened.agentId, "replacement");
    expect(f.setThinking).toHaveBeenCalledWith(opened.agentId, "high");
    expect(updated).toMatchObject({ id: bot.id, mainAgentId: opened.agentId, provider: "codex", model: "replacement", thinking: "high", pendingModel: false });
    expect(updated.memories).toEqual([memory]);
    expect(await f.service.open(bot.id)).toEqual(opened);
    expect(f.createAgent).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("已关闭的主对话先恢复再换模型，保留原 agent", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.open(bot.id);
    f.agents.get(opened.agentId)!.status = "closed";
    const updated = await f.service.update(bot.id, { model: "replacement" });
    expect(f.agents.get(opened.agentId)?.status).toBe("idle");
    expect(f.setModel).toHaveBeenCalledWith(opened.agentId, "replacement");
    expect(updated).toMatchObject({ mainAgentId: opened.agentId, provider: "codex", model: "replacement", pendingModel: false });
    expect(f.createAgent).toHaveBeenCalledTimes(1);
  });

  it("忙碌期间仅保存待应用设置，空闲后应用并清除 pending", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    const opened = await f.service.open(bot.id);
    f.agents.get(opened.agentId)!.status = "running";
    expect(await f.service.update(bot.id, { model: "replacement" })).toMatchObject({ mainAgentId: opened.agentId, pendingModel: true });
    expect(f.setModel).not.toHaveBeenCalled();
    expect(await f.service.open(bot.id)).toEqual(opened);
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
    const before = await f.service.open(bot.id);
    const memory = f.service.bots.memoryAdd(bot.id, "使用中文");
    const updated = await f.service.update(bot.id, { provider: "claude", model: "replacement" });
    expect(f.invoke).toHaveBeenCalledWith("vibe-board", "vibe.bot.handoff", { agentId: before.agentId });
    expect(f.createAgent).toHaveBeenCalledTimes(2);
    expect(updated.mainAgentId).not.toBe(before.agentId);
    expect(updated).toMatchObject({ id: bot.id, pendingModel: false });
    expect(updated.memories).toEqual([memory]);
    expect(f.send).toHaveBeenCalledWith(updated.mainAgentId, "交接包：未决问题与下一步", { sourceAgentId: updated.mainAgentId });
    expect(f.agents.get(before.agentId)).toMatchObject({ provider: "codex", archivedAt: null });
    expect(f.agents.get(updated.mainAgentId!)).toMatchObject({ provider: "claude", labels: expect.objectContaining({ "vibe.bot": bot.id }) });
    expect((await f.service.open(bot.id)).agentId).toBe(updated.mainAgentId);
    expect(f.setModel).not.toHaveBeenCalled();
  });
});

it("真实旧总 agent 与项目 agent 无损迁移，重启不重复建 bot 且保留原会话和用户编辑", async () => {
  const f = fixture();
  f.seedLegacy("legacy-master", { role: "master", custom: "保留" });
  f.seedLegacy("legacy-project", { "vibe.role": "project", "vibe.project_id": "p", custom: "保留" });
  await f.service.ready();
  const master = f.service.bots.list({ kind: "independent" })[0]!;
  const project = f.service.bots.list({ projectId: "p" })[0]!;
  expect(master).toMatchObject({ kind: "independent", name: "助手", mainAgentId: "legacy-master", thinking: "high" });
  expect(master.instructions).toBe("");
  expect(f.service.prompt(master)).toContain("你不自动派发");
  expect(f.service.prompt(master)).toContain("按需使用");
  expect(project).toMatchObject({ name: "项目 bot", mainAgentId: "legacy-project" });
  expect(await f.service.defaultBot("p")).toEqual({ botId: project.id, mainAgentId: "legacy-project" });
  expect(await f.service.open(master.id)).toEqual({ agentId: "legacy-master", workspaceId: "project-root" });
  expect(await f.service.open(project.id)).toEqual({ agentId: "legacy-project", workspaceId: "project-root" });
  await f.service.update(master.id, { name: "我的总助理", instructions: "保留说明" });
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


describe("个人记忆送达", () => {
  it("主对话创建和换 provider 重建都把已有记忆写入 system prompt", async () => {
    const f = fixture();
    const bot = await f.createProjectBot();
    f.service.bots.memoryAdd(bot.id, "回答优先使用中文", true);
    const first = await f.service.open(bot.id);
    expect(f.createAgent.mock.calls[0][0].config.systemPrompt).toContain("回答优先使用中文");
    expect(f.service.memoryDelivery.prepare(bot.id, first.agentId, f.service.bots.memories(bot.id), [f.service.prompt(bot), bot.instructions].filter(Boolean).join("\n\n"))).toBeUndefined();
    await f.service.update(bot.id, { provider: "claude", model: "replacement" });
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
    const opened = await f.service.open(bot.id);
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
    const first = await f.service.open(one.id);
    const second = await f.service.open(two.id);
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
  expect(bot.name).toBe("助手");
  expect(bot.instructions).toBe("");
  expect(bot.instructions).toBe("按我写的角色说明回答");
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
