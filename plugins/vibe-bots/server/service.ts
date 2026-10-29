import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import type {
  PaseoAgent, PaseoAgentCreateOptions, PaseoAgentListOptions, PaseoAgentSendOptions,
} from "@getpaseo/client";
import { z } from "zod";
import {
  BotCreateSchema, BotPatchSchema, type Bot, type BotCreate, type BotPatch,
} from "./vibe/contract/bots";
import { presetModels, presetModeId } from "./vibe/contract/preset-models";
import { isModelUnavailableError } from "./vibe/contract/error-class";
import { createBotStore } from "./vibe/db/bots";
import { createVibeStore } from "./vibe/db/commands";
import { createTaskRuntimeCommands } from "./vibe/db/task-runtime";
import { resolveVibeHome, type VibeDb } from "./vibe/db/sqlite";

import { createMemoryDelivery, memoryContext } from "./memory";
export { memoryContext } from "./memory";

interface OpenedBot {
  agentId: string;
  workspaceId: string | null;
}

export interface BotAgent extends Pick<PaseoAgent,
  "id" | "provider" | "model" | "thinkingOptionId" | "status" | "labels" | "updatedAt" | "archivedAt"
> {
  workspaceId?: string | null;
  currentModeId?: PaseoAgent["currentModeId"];
  activeTurn?: PaseoAgent["activeTurn"];
}

interface BotAgentHandle {
  id: string;
  workspaceId: string | null;
  refresh(): Promise<unknown>;
  current(): BotAgent | null;
  setLabels(labels: Record<string, string>): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinkingOption(id: string | null): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setTitle(title: string): Promise<void>;
  send(text: string, options: PaseoAgentSendOptions): Promise<void>;
  resume(): Promise<void>;
}

/** The service only needs public host operations; narrower results keep host simulation honest. */
export interface BotHost {
  agents: {
    ref(id: string): BotAgentHandle;
    create(options: PaseoAgentCreateOptions): Promise<BotAgentHandle>;
    list(options?: PaseoAgentListOptions): Promise<{
      entries: Array<{ agent: BotAgent }>;
      pageInfo: { nextCursor: string | null };
    }>;
  };
  projects: {
    list(): Promise<{ projects: Array<{ projectId: string; projectRootPath: string }> }>;
  };
  providers: {
    listAvailable(): Promise<{ providers: Array<{ provider: string; available: boolean }> }>;
    listModels(provider: string): Promise<{
      models?: Array<{
        id: string; label: string; isDefault?: boolean; isSelectable?: boolean;
        thinkingOptions?: Array<{ id: string; label: string }>;
      }>;
    }>;
    listModes(provider: string): Promise<{ modes?: Array<{ id: string; label: string }> }>;
  };
  plugins: {
    invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
  };
}

export function assertCreationScope(caller: Bot, input: BotCreate) {
  if (caller.kind === "project" && (input.kind !== "project" || input.projectId !== caller.projectId)) {
    throw new Error("项目 bot 只能创建本项目的 bot");
  }
}

export function assertPermissionTightening(previous: Bot["permissionMode"], next: Bot["permissionMode"]) {
  const rank = { "accept-edits": 0, auto: 1, full: 2 };
  if (rank[next] > rank[previous]) {
    throw new Error("bot 只能收紧权限，不能放宽权限；请由用户在资料页调整");
  }
}

function legacyPermission(agent: BotAgent): Bot["permissionMode"] {
  if (["full-access", "bypassPermissions"].includes(agent.currentModeId ?? "")) return "full";
  if (["auto", "auto-review"].includes(agent.currentModeId ?? "")) return "auto";
  return "accept-edits";
}

function validateAvatar(path: string) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 512 * 1024) {
    throw new Error("自定义头像必须是 512 KB 以内的图片文件");
  }
  const fd = openSync(path, "r");
  const magic = Buffer.alloc(12);
  try {
    readSync(fd, magic, 0, 12, 0);
  } finally {
    closeSync(fd);
  }
  const image =
    magic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    magic.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    /^GIF8[79]a/.test(magic.toString("ascii", 0, 6)) ||
    (magic.toString("ascii", 0, 4) === "RIFF" && magic.toString("ascii", 8, 12) === "WEBP");
  if (!image) throw new Error("头像内容必须是 PNG、JPEG、WebP 或 GIF 图片");
}

export function createBotService(db: VibeDb, paseo: BotHost) {
  const bots = createBotStore(db);
  const memoryDelivery = createMemoryDelivery(db);
  const store = createVibeStore(db);
  let migration: Promise<void> | null = null;
  let settingsMigration: Promise<void> | null = null;
  let lastSettingsAttempt = 0;
  const openings = new Map<string, Promise<OpenedBot>>();
  const defaults = new Map<string, Promise<{ botId: string; mainAgentId: string | null }>>();
  const updates = new Map<string, Promise<void>>();
  const continuations = new Map<string, Promise<unknown>>();
  const live = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  async function agent(id: string): Promise<BotAgent | null> {
    const handle = paseo.agents.ref(id);
    await handle.refresh();
    return handle.current();
  }

  async function hostProjects() {
    return (await paseo.projects.list()).projects;
  }

  async function project(id: string) {
    const found = (await hostProjects()).find((entry) => entry.projectId === id);
    if (!found) throw new Error("项目不存在或已归档");
    return found;
  }

  async function allAgents() {
    const entries: BotAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({
        includeBackground: true,
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      entries.push(...page.entries.map((entry) => entry.agent));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return entries;
  }

  async function migrate() {
    const entries = await allAgents();
    const masters = store.sessions.list({ role: "master" }).toReversed();
    const statePath = join(resolveVibeHome(), "master", "state.json");
    const state = existsSync(statePath)
      ? z.object({ agent: z.object({ agentId: z.string() }).optional() })
          .parse(JSON.parse(readFileSync(statePath, "utf8")))
      : null;
    const authoritativeId = state?.agent?.agentId ?? masters[0]?.agentId;
    const migratedMaster = db.prepare<{ bot_id: string }>(
      "SELECT bot_id FROM bot_legacy_migration WHERE source='master'",
    ).get();
    const legacyMaster = migratedMaster
      ? entries.find((entry) => entry.id === bots.require(migratedMaster.bot_id).mainAgentId)
      : entries.find((entry) => entry.id === authoritativeId && !entry.labels["vibe.bot"]) ??
        entries.filter((entry) => entry.labels.role === "master" && !entry.labels["vibe.bot"])
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (legacyMaster) {
      const bot = bots.legacy("master", {
        kind: "independent", name: "助手", instructions: "", provider: legacyMaster.provider, model: legacyMaster.model,
        thinking: legacyMaster.thinkingOptionId ?? "", permissionMode: legacyPermission(legacyMaster),
      }, legacyMaster.id);
      if (bot.mainAgentId) {
        await paseo.agents.ref(bot.mainAgentId).setLabels({ "vibe.bot": bot.id, "vibe.bot-thread": "main" });
      }
    }
    for (const native of await hostProjects()) {
      const migrated = db.prepare<{ bot_id: string }>(
        "SELECT bot_id FROM bot_legacy_migration WHERE source=?",
      ).get("project:" + native.projectId);
      const previous = migrated
        ? entries.find((entry) => entry.id === bots.require(migrated.bot_id).mainAgentId)
        : entries.filter((entry) =>
            entry.labels["vibe.role"] === "project" &&
            entry.labels["vibe.project_id"] === native.projectId && !entry.labels["vibe.bot"],
          ).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!previous) continue;
      const bot = bots.legacy("project:" + native.projectId, {
        kind: "project", projectId: native.projectId, name: "项目 bot",
        provider: previous.provider, model: previous.model, thinking: previous.thinkingOptionId ?? "",
        permissionMode: legacyPermission(previous),
      }, previous.id);
      if (bot.mainAgentId) {
        await paseo.agents.ref(bot.mainAgentId).setLabels({ "vibe.bot": bot.id, "vibe.bot-thread": "main" });
      }
      if (!bots.defaultGet(native.projectId) && !bot.archivedAt) bots.defaultSet(native.projectId, bot.id);
    }
  }

  function ready() {
    if (!migration) {
      migration = migrate().then(() => {
        for (const bot of bots.list()) if (bot.pendingModel) scheduleApply(bot.id);
        migrateMasterSettings();
        return undefined;
      }).catch((error) => {
        migration = null;
        throw error;
      });
    } else {
      migrateMasterSettings();
    }
    return migration;
  }

  function migrateMasterSettings() {
    if (closed || settingsMigration || Date.now() - lastSettingsAttempt < 30_000) return;
    const source = db.prepare<{ bot_id: string }>(
      "SELECT bot_id FROM bot_legacy_migration WHERE source='master'",
    ).get();
    if (!source || db.prepare("SELECT 1 FROM bot_legacy_migration WHERE source='master-settings'").get()) return;
    lastSettingsAttempt = Date.now();
    settingsMigration = (async () => {
      const snapshot = z.object({
        presetId: z.string().nullable(), candidateIndex: z.number().int().nonnegative(),
        backupModels: z.array(z.object({ provider: z.string(), model: z.string(), thinking: z.string() })),
        instructions: z.string(),
        notifications: z.object({ enabled: z.boolean(), completed: z.boolean(), failed: z.boolean() }),
        permissionMode: z.enum(["accept-edits", "auto", "full"]),
      }).parse(await paseo.plugins.invoke("vibe-master", "vibe.master.bot_migration", {}));
      db.immediate(() => {
        if (db.prepare("SELECT 1 FROM bot_legacy_migration WHERE source='master-settings'").get()) return;
        const bot = bots.require(source.bot_id);
        // An edit made while the legacy plugin was offline wins over its delayed settings snapshot.
        if (bot.createdAt === bot.updatedAt) {
          const presetId = snapshot.presetId && store.presets.get(snapshot.presetId) ? snapshot.presetId : null;
          bots.update(bot.id, {
            presetId, notifications: snapshot.notifications,
            permissionMode: snapshot.permissionMode,
            backupModels: presetId ? [] : snapshot.backupModels,
          });
          if (presetId && snapshot.candidateIndex > 0) {
            db.prepare("INSERT INTO bot_model_state(bot_id,candidate_index) VALUES(?,?) " +
              "ON CONFLICT(bot_id) DO UPDATE SET candidate_index=excluded.candidate_index")
              .run(bot.id, snapshot.candidateIndex);
          }
        }
        db.prepare("INSERT OR IGNORE INTO bot_legacy_migration(source,bot_id) VALUES('master-settings',?)")
          .run(bot.id);
      });
    })().catch((error) => {
      console.error("[vibe-bots] 旧总 agent 配置暂未迁移，后续请求将重试", error);
    }).finally(() => { settingsMigration = null; });
  }

  function view(bot: Bot) {
    return {
      ...bot, memories: bots.memories(bot.id),
      isDefault: !!bot.projectId && bots.defaultGet(bot.projectId) === bot.id,
    };
  }

  async function caller(id: string | null | undefined) {
    await ready();
    if (!id) throw new Error("工具仅供 bot 使用");
    const record = bots.list().find((bot) => bot.mainAgentId === id);
    if (!record) throw new Error("调用者不是当前 bot 主对话");
    const current = await agent(id);
    if (!current || current.archivedAt || current.labels["vibe.bot"] !== record.id ||
        current.labels["vibe.bot-thread"] !== "main") {
      throw new Error("bot 身份标签不匹配");
    }
    return record;
  }

  async function models(query = "") {
    const available = await paseo.providers.listAvailable();
    const providers = await Promise.all(available.providers.filter((entry) => entry.available)
      .map(async (entry) => {
        const catalog = await paseo.providers.listModels(entry.provider);
        const values = (catalog.models ?? []).filter((model) => model.isSelectable !== false).map((model) => ({
          id: model.id, name: model.label, isDefault: !!model.isDefault,
          thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
            id: option.id, name: option.label,
          })),
        }));
        return {
          provider: entry.provider,
          defaultModel: values.find((model) => model.isDefault)?.id ?? values[0]?.id ?? null,
          models: values.filter((model) =>
            (entry.provider + " " + model.id + " " + model.name).toLowerCase().includes(query.toLowerCase()),
          ),
        };
      }));
    return { providers, presets: store.presets.list().map((preset) => ({ id: preset.id, name: preset.name })) };
  }

  async function primary(bot: Bot) {
    if (bot.presetId) {
      const preset = store.presets.get(bot.presetId);
      if (!preset) throw new Error("预设不存在：" + bot.presetId);
      const first = presetModels(preset)[0];
      if (!first) throw new Error("预设没有可用模型");
      return { ...first, thinking: bot.thinking || first.thinking, instructions: preset.instructions, runtimeEnv: preset.runtimeEnv };
    }
    if (bot.provider && bot.model) {
      return {
        provider: bot.provider, model: bot.model, thinking: bot.thinking,
        permissionMode: bot.permissionMode, instructions: "", runtimeEnv: null,
      };
    }
    if (bot.kind === "project") {
      const selection = z.object({
        config: z.object({
          provider: z.string(), thinkingOptionId: z.string().optional(), systemPrompt: z.string().optional(),
        }),
        runtimeEnv: z.string().optional(),
      }).parse(await paseo.plugins.invoke("vibe-board", "vibe.project.bot.model", { projectId: bot.projectId }));
      const slash = selection.config.provider.indexOf("/");
      return {
        provider: selection.config.provider.slice(0, slash), model: selection.config.provider.slice(slash + 1),
        thinking: bot.thinking || selection.config.thinkingOptionId || "",
        permissionMode: bot.permissionMode, instructions: selection.config.systemPrompt ?? "",
        runtimeEnv: selection.runtimeEnv ?? null,
      };
    }
    const catalog = await models();
    const first = catalog.providers.find((entry) => entry.defaultModel);
    if (!first?.defaultModel) throw new Error("主机没有可用默认模型，请先配置 provider");
    return {
      provider: first.provider, model: first.defaultModel, thinking: bot.thinking,
      permissionMode: bot.permissionMode, instructions: "", runtimeEnv: null,
    };
  }

  async function candidates(bot: Bot) {
    const chain = [await primary(bot)];
    if (bot.presetId) {
      const seen = new Set<string>();
      function append(id: string, skipFirst = false) {
        if (seen.has(id)) return;
        seen.add(id);
        const preset = store.presets.get(id);
        if (!preset) throw new Error("备用预设不存在：" + id);
        const choices = presetModels(preset);
        for (const candidate of skipFirst ? choices.slice(1) : choices) {
          chain.push({ ...candidate, instructions: preset.instructions, runtimeEnv: preset.runtimeEnv });
        }
        for (const fallback of preset.fallbackPresetIds ?? []) append(fallback);
      }
      append(bot.presetId, true);
    }
    for (const candidate of bot.backupModels) {
      chain.push({ ...candidate, permissionMode: bot.permissionMode, instructions: "", runtimeEnv: null });
    }
    return chain;
  }

  function candidateIndex(id: string) {
    return db.prepare<{ candidate_index: number }>(
      "SELECT candidate_index FROM bot_model_state WHERE bot_id=?",
    ).get(id)?.candidate_index ?? 0;
  }

  async function selected(bot: Bot, reset = false) {
    const chain = await candidates(bot);
    const target = chain[reset ? 0 : candidateIndex(bot.id)];
    if (!target) throw new Error("bot 所有候选模型均不可用，请重新选择模型");
    if (!target.model) {
      const catalog = await models();
      const provider = catalog.providers.find((entry) => entry.provider === target.provider);
      if (!provider?.defaultModel) throw new Error("provider 没有可用默认模型：" + target.provider);
      return { ...target, model: provider.defaultModel };
    }
    return target;
  }

  async function advance(id: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isModelUnavailableError(error) && !/quota|rate.limit|insufficient|额度|余额|限额|未知模型/i.test(message)) {
      return false;
    }
    const chain = await candidates(bots.require(id));
    const index = candidateIndex(id) + 1;
    if (index >= chain.length) return false;
    db.prepare("INSERT INTO bot_model_state(bot_id,candidate_index) VALUES(?,?) " +
      "ON CONFLICT(bot_id) DO UPDATE SET candidate_index=excluded.candidate_index").run(id, index);
    bots.pending(id, true);
    return true;
  }

  async function validate(bot: Bot, all = true, reset = false) {
    if (bot.avatarPath) validateAvatar(bot.avatarPath);
    if (!!bot.provider !== !!bot.model) throw new Error("provider 与模型必须同时指定，或同时清空以使用默认模型");
    const active = await selected(bot, reset);
    const catalog = await models();
    for (const candidate of all ? await candidates(bot) : [active]) {
      const provider = catalog.providers.find((entry) => entry.provider === candidate.provider);
      const model = provider?.models.find((entry) => entry.id === candidate.model);
      if (!candidate.model && provider?.defaultModel) continue;
      if (!model) {
        const choices = provider?.models.map((entry) => entry.id) ??
          catalog.providers.flatMap((entry) => entry.models.map((item) => entry.provider + "/" + item.id));
        throw new Error("未知模型「" + candidate.provider + "/" + candidate.model + "」。可选值：" + choices.join("、"));
      }
      if (candidate.thinking && !model.thinkingOptions.some((option) => option.id === candidate.thinking)) {
        throw new Error("未知思考强度「" + candidate.thinking + "」。可选值：" +
          model.thinkingOptions.map((option) => option.id).join("、"));
      }
    }
    return active;
  }

  async function create(input: BotCreate, actor?: Bot) {
    await ready();
    const value = BotCreateSchema.parse(input);
    if (actor) {
      assertCreationScope(actor, value);
      assertPermissionTightening(actor.permissionMode, value.permissionMode);
    }
    if (value.projectId) await project(value.projectId);
    await validate({
      ...value, id: "bot_validation", mainAgentId: null, pendingModel: false,
      createdAt: "", updatedAt: "", archivedAt: null,
    });
    const bot = db.immediate(() => {
      const next = bots.create(value);
      if (next.projectId && !bots.defaultGet(next.projectId)) bots.defaultSet(next.projectId, next.id);
      return next;
    });
    return view(bot);
  }

  async function defaultBot(projectId: string) {
    await ready();
    const existing = defaults.get(projectId);
    if (existing) return existing;
    const job = (async () => {
      await project(projectId);
      let id = bots.defaultGet(projectId);
      if (!id) {
        id = bots.list({ kind: "project", projectId })[0]?.id ??
          (await create({ kind: "project", projectId, name: "项目 bot" })).id;
        bots.defaultSet(projectId, id);
      }
      return { botId: id, mainAgentId: bots.require(id).mainAgentId };
    })();
    defaults.set(projectId, job);
    try {
      return await job;
    } finally {
      defaults.delete(projectId);
    }
  }

  function prompt(bot: Bot) {
    if (bot.kind === "project") {
      return store.prompts.resolve("project.agent.role", { projectId: bot.projectId! });
    }
    return `你是独立 bot「${bot.name}」${bot.title ? `，头衔是「${bot.title}」` : ""}。遵循用户填写的角色说明。当前提供的工具均可按需使用。不得写入密钥等敏感信息。派发只由调度器规则执行，你不自动派发。`;
  }

  async function mode(provider: string, permission: Bot["permissionMode"]) {
    const catalog = await paseo.providers.listModes(provider);
    const modes = catalog.modes ?? [];
    const requested = presetModeId(provider, permission);
    if (requested) {
      const actual = modes.find((entry) => entry.id === requested) ??
        (permission === "auto" ? modes.find((entry) => entry.id === "auto-review") : undefined);
      if (!actual) throw new Error("provider 不支持所选权限模式：" + permission);
      return actual.id;
    }
    const fallback = modes.find((entry) => ["default", "acceptEdits", "accept-edits"].includes(entry.id)) ??
      modes.find((entry) => !["full-access", "bypassPermissions", "auto"].includes(entry.id));
    return fallback?.id;
  }

  async function spawn(bot: Bot, handoff?: string): Promise<OpenedBot> {
    try {
      return await spawnOnce(bot, handoff);
    } catch (error) {
      if (await advance(bot.id, error)) return spawn(bots.require(bot.id), handoff);
      throw error;
    }
  }

  async function spawnOnce(bot: Bot, handoff?: string): Promise<OpenedBot> {
    const target = await validate(bot, false);
    const cwd = bot.projectId
      ? (await project(bot.projectId)).projectRootPath
      : join(resolveVibeHome(), "bots", bot.id);
    if (!bot.projectId) mkdirSync(cwd, { recursive: true });
    const permission = await mode(target.provider, bot.permissionMode);
    const memories = bots.memories(bot.id);
    const created = await paseo.agents.create({
      cwd, title: bot.name,
      labels: {
        "vibe.bot": bot.id, "vibe.bot-thread": "main",
        ...(bot.projectId ? { "vibe.role": "project", "vibe.project_id": bot.projectId } : {}),
      },
      env: {
        VIBE_ROLE: bot.kind, VIBE_BOT_ID: bot.id,
        ...(bot.projectId ? { VIBE_PROJECT_ID: bot.projectId } : {}),
        ...(target.runtimeEnv ? { VIBE_RUNTIME_ENV: target.runtimeEnv } : {}),
      },
      config: {
        provider: target.provider + "/" + target.model,
        systemPrompt: [prompt(bot), bot.instructions, target.instructions, memoryContext(memories)].filter(Boolean).join("\n\n"),
        ...(target.thinking ? { thinkingOptionId: target.thinking } : {}),
        ...(permission ? { modeId: permission } : {}),
      },
    });
    memoryDelivery.record(bot.id, created.id, memories, [prompt(bot), bot.instructions].filter(Boolean).join("\n\n"));
    await created.refresh();
    if (bot.kind === "independent") {
      const previous = bot.mainAgentId ? store.sessions.getByAgent(bot.mainAgentId) : undefined;
      createTaskRuntimeCommands(db).registerSession({
        workspaceId: null, projectId: null, agentId: created.id, role: "master",
        provider: target.provider, model: target.model, thinking: target.thinking,
        candidateIndex: candidateIndex(bot.id), previousSessionId: previous?.id ?? null,
      });
      if (previous && previous.state !== "ended") {
        store.sessions.setState(previous.id, "ended", { outcome: "bot_main_replaced" });
      }
    }
    bots.setMain(bot.id, created.id);
    if (handoff) {
      try {
        await created.send(handoff, { sourceAgentId: created.id });
      } catch (error) {
        if (bot.mainAgentId) bots.setMain(bot.id, bot.mainAgentId);
        throw error;
      }
    }
    return { agentId: created.id, workspaceId: created.workspaceId ?? null };
  }

  async function apply(id: string): Promise<void> {
    if (closed) return;
    const previous = updates.get(id);
    if (previous) return previous;
    const job = (async () => {
      const bot = bots.require(id);
      if (!bot.pendingModel || !bot.mainAgentId || bot.archivedAt) return;
      const current = await agent(bot.mainAgentId);
      if (!current) return;
      if (live.has(current.id) || current.activeTurn || current.status === "running" ||
          current.status === "initializing" || continuations.has(id)) {
        scheduleApply(id);
        return;
      }
      if (current.archivedAt) {
        await spawn(bot);
        return;
      }
      const target = await validate(bot, false);
      if (current.provider === target.provider) {
        await changeModel(bot, current, target);
      } else {
        const packet = z.object({ text: z.string() }).parse(
          await paseo.plugins.invoke("vibe-board", "vibe.bot.handoff", { agentId: current.id }),
        );
        await spawn(bot, packet.text);
      }
    })();
    updates.set(id, job);
    try {
      await job;
    } catch (error) {
      updates.delete(id);
      if (await advance(id, error)) return apply(id);
      throw error;
    } finally {
      updates.delete(id);
    }
  }

  async function changeModel(bot: Bot, current: BotAgent, target: Awaited<ReturnType<typeof selected>>) {
    const handle = paseo.agents.ref(current.id);
    if (current.status === "closed") {
      await handle.resume();
      await handle.refresh();
      const resumed = handle.current();
      if (!resumed) throw new Error("原 bot 主对话恢复后暂不可读，请稍后重试");
      if (resumed.activeTurn || resumed.status === "running" || resumed.status === "initializing") {
        scheduleApply(bot.id);
        return;
      }
    }
    await handle.setModel(target.model);
    await handle.setThinkingOption(target.thinking || null);
    const permission = legacyPermission(current) === bot.permissionMode
      ? current.currentModeId
      : await mode(target.provider, bot.permissionMode);
    if (!permission && bot.permissionMode === "accept-edits" &&
        ["full-access", "bypassPermissions", "auto", "auto-review"].includes(current.currentModeId ?? "")) {
      throw new Error("无法解析 provider 的默认权限模式，暂未应用权限收紧；请检查 provider 模式目录");
    }
    if (permission && permission !== current.currentModeId) await handle.setMode(permission);
    bots.pending(bot.id, false);
    const session = store.sessions.getByAgent(current.id);
    if (session) {
      db.prepare("UPDATE agent_session SET current_provider=?,model=?,thinking=?,candidate_index=? WHERE id=?")
        .run(target.provider, target.model, target.thinking, candidateIndex(bot.id), session.id);
    }
  }

  function scheduleApply(id: string) {
    if (closed || retryTimers.has(id)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(id);
      void apply(id).catch((error) => console.error("[vibe-bots] 待应用模型变更失败", error));
    }, 500);
    retryTimers.set(id, timer);
  }

  async function open(id: string) {
    await ready();
    const existing = openings.get(id);
    if (existing) return existing;
    if (continuations.has(id)) throw new Error("bot 正在交接，请稍后打开");
    const job = (async () => {
      const bot = bots.require(id);
      if (bot.archivedAt) throw new Error("bot 已归档");
      await apply(id);
      const latest = bots.require(id);
      if (latest.mainAgentId) {
        const current = await agent(latest.mainAgentId);
        if (current?.archivedAt) return spawn(latest);
        if (current) {
          if (current.status === "closed") await paseo.agents.ref(current.id).resume();
          return { agentId: current.id, workspaceId: current.workspaceId ?? null };
        }
        throw new Error("原主对话暂不可读，保留入口，请稍后重试");
      }
      return spawn(latest);
    })();
    openings.set(id, job);
    try {
      return await job;
    } finally {
      openings.delete(id);
    }
  }

  async function update(id: string, patch: BotPatch, actor?: Bot) {
    await ready();
    const current = bots.require(id);
    const value = BotPatchSchema.parse(patch);
    if (actor) {
      if (actor.id !== id) throw new Error("只能修改自己的 bot 资料");
      if (value.permissionMode) assertPermissionTightening(current.permissionMode, value.permissionMode);
    }
    if (("provider" in value || "model" in value) && value.presetId === undefined) {
      const active = await selected(current);
      value.presetId = null;
      if (value.provider === undefined) value.provider = active.provider;
      if (value.model === undefined) value.model = active.model;
    }
    const changesRuntime = ["provider", "model", "thinking", "presetId", "backupModels", "permissionMode"]
      .some((key) => key in value);
    if (changesRuntime) await validate({ ...current, ...value }, true, true);
    else if (value.avatarPath) validateAvatar(value.avatarPath);
    const next = db.immediate(() => {
      if (current.kind === "independent" && Object.keys(value).length) {
        const legacy = db.prepare<{ bot_id: string }>(
          "SELECT bot_id FROM bot_legacy_migration WHERE source='master'",
        ).get();
        if (legacy?.bot_id === id) {
          // Persist user precedence, even when creation and this edit share the same millisecond.
          db.prepare("INSERT OR IGNORE INTO bot_legacy_migration(source,bot_id) VALUES('master-settings',?)")
            .run(id);
        }
      }
      const result = bots.update(id, value);
      if (["provider", "model", "thinking", "presetId", "backupModels"].some((key) => key in value)) {
        db.prepare("DELETE FROM bot_model_state WHERE bot_id=?").run(id);
      }
      if (["provider", "model", "thinking", "presetId", "permissionMode"].some((key) => key in value)) {
        bots.pending(id, true);
      }
      return result;
    });
    await apply(id);
    if (value.name && next.mainAgentId) await paseo.agents.ref(next.mainAgentId).setTitle(value.name);
    return view(bots.require(id));
  }

  async function failover(id: string, error: unknown) {
    if (!(await advance(id, error))) return false;
    await apply(id);
    return true;
  }

  async function continueConversation(input: {
    agentId: string; reason: "context" | "failure"; message: string; summary: string;
    candidateIndex?: number;
  }) {
    await ready();
    const source = await agent(input.agentId);
    const bot = bots.list({ kind: "independent" }).find((item) => item.mainAgentId === input.agentId);
    if (!bot) {
      const replacement = source?.labels["vibe.bot"] ? bots.get(source.labels["vibe.bot"]) : null;
      return {
        status: "deferred" as const, reason: "请求来源已不再是 bot 主对话",
        ...(replacement?.mainAgentId ? { agentId: replacement.mainAgentId } : {}),
      };
    }
    if (!source || source.activeTurn || live.has(input.agentId) ||
        openings.has(bot.id) || updates.has(bot.id) || continuations.has(bot.id)) {
      return { status: "paused" as const, reason: "原 bot 会话尚未空闲，等待后重试" };
    }
    if (input.reason === "failure" && input.candidateIndex !== undefined &&
        input.candidateIndex !== candidateIndex(bot.id)) {
      return { status: "deferred" as const, reason: "此失败已应用备用模型，不重复轮换", agentId: input.agentId };
    }
    const job = (async () => {
      if (input.reason === "failure" && !(await advance(bot.id, new Error(input.message)))) {
        return { status: "exhausted" as const, reason: "bot 候选模型已耗尽" };
      }
      const packet = z.object({ text: z.string() }).parse(
        await paseo.plugins.invoke("vibe-board", "vibe.bot.handoff", { agentId: input.agentId }),
      );
      const opened = await spawn(bots.require(bot.id), packet.text);
      const session = store.sessions.getByAgent(opened.agentId);
      return {
        status: "continued" as const, reason: "bot 已保留旧会话并接续", agentId: opened.agentId,
        ...(session ? { sessionId: session.id } : {}),
      };
    })();
    continuations.set(bot.id, job);
    try {
      return await job;
    } finally {
      continuations.delete(bot.id);
    }
  }

  async function close() {
    closed = true;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    await Promise.allSettled([
      ...updates.values(), ...openings.values(), ...defaults.values(), ...continuations.values(),
      ...(migration ? [migration] : []),
      ...(settingsMigration ? [settingsMigration] : []),
    ]);
  }

  return {
    bots, memoryDelivery, ready, view, caller, models, create, defaultBot, open, update, apply, prompt,
    live, failover, close, continueConversation,
  };
}
export type BotService = ReturnType<typeof createBotService>;
