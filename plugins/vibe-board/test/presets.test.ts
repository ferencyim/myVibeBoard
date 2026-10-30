import { cleanDefaults, resolveTaskRoles } from "../shared/vibe/contract";
import { getProjectDefaults, setProjectDefaults } from "../server/project-defaults";
import {
  openDefaultsForm,
  setModelDefault,
  inheritedDefaultLabel,
  INHERIT,
  DISABLED,
} from "../client/presets/defaults-model";
import { afterEach, describe, expect, it } from "vitest";
import {
  draftToPayload,
  EMPTY_PRESET_DRAFT,
  movePresetModel,
  plannersOf,
  presetToDraft,
  quotaFor,
  setPlanner,
  validateDraft,
  type ProviderUsageLike,
} from "../client/presets/logic";
import { presetsCreateRpc, presetsUpdateRpc } from "../shared/rpc";
import { createBoardService, openBoardRuntime } from "../server/service";
import { resolveMainConfig } from "../server/main-model";
const runtimes: Array<ReturnType<typeof openBoardRuntime>> = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});
function setupBoard() {
  const runtime = openBoardRuntime({ path: ":memory:" });
  runtimes.push(runtime);
  return { board: createBoardService(runtime) };
}
describe("quota display (providers.listUsage)", () => {
  const usage: ProviderUsageLike[] = [
    {
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      windows: [
        { id: "5h", label: "5 hours", shortLabel: "5h", remainingPct: 73 },
        { id: "wk", label: "Week", shortLabel: "wk", usedPct: 95 },
      ],
    },
    { providerId: "codex", displayName: "Codex", status: "error", windows: [] },
    { providerId: "x", displayName: "X", status: "available", windows: [{ id: "a", label: "a" }] },
  ];
  it("shows the tightest window with a tone", () => {
    expect(quotaFor("claude", usage)).toEqual({ text: "wk 5%", remainingPct: 5, tone: "danger" });
    expect(quotaFor("codex", usage)).toBeNull();
    expect(quotaFor("x", usage)).toBeNull();
    expect(quotaFor("missing", usage)).toBeNull();
    expect(quotaFor("claude", null)).toBeNull();
    expect(
      quotaFor("claude", [{ ...usage[0]!, windows: [{ id: "a", label: "A", remainingPct: 50 }] }]),
    ).toEqual({ text: "A 50%", remainingPct: 50, tone: "ok" });
  });
});

describe("preset persistence round trip", () => {
  it("resolves #1 project preset over global and leaves missing defaults to the host", () => {
    const { board } = setupBoard();
    expect(resolveMainConfig(board.store, "native-project")).toEqual({});
    const global = board.store.presets.create({
      name: "Global",
      provider: "codex",
      model: "global-model",
      thinking: "high",
    });
    const project = board.store.presets.create({
      name: "Project",
      provider: "claude",
      model: "project-model",
      thinking: "",
    });
    board.store.modelDefaults.setGlobal({ main: global.id });
    expect(resolveMainConfig(board.store, "native-project")).toEqual({
      config: { provider: "codex", model: "global-model", thinkingOptionId: "high" },
    });
    board.store.projects.create({
      name: "Project",
      prefix: "PRJ",
      repoPath: "/repo",
      paseoProjectId: "native-project",
      defaultPresets: { main: project.id },
    });
    expect(resolveMainConfig(board.store, "native-project")).toEqual({
      config: { provider: "claude", model: "project-model" },
    });
  });
  it("resolves legacy project defaults by repository path before a native link exists", () => {
    const { board } = setupBoard();
    const global = board.store.presets.create({
      name: "Global",
      provider: "codex",
      model: "global-model",
    });
    const local = board.store.presets.create({
      name: "Local",
      provider: "claude",
      model: "local-model",
    });
    board.store.modelDefaults.setGlobal({ main: global.id });
    board.store.projects.create({
      name: "Legacy",
      prefix: "LEG",
      repoPath: "/legacy",
      defaultPresets: { main: local.id },
    });
    expect(resolveMainConfig(board.store, "native-project", "/legacy")).toEqual({
      config: { provider: "claude", model: "local-model" },
    });
    expect(() =>
      resolveMainConfig(
        { ...board.store, presets: { ...board.store.presets, get: () => undefined } },
        "native-project",
        "/legacy",
      ),
    ).toThrow("#1 主会话预设不存在");
  });

  it("reorders candidates with their settings and mirrors the first model in the payload", () => {
    const first = {
      provider: "claude",
      model: "sonnet",
      thinking: "low",
      permissionMode: "auto" as const,
    };
    const second = {
      provider: "codex",
      model: "gpt",
      thinking: "high",
      permissionMode: "full" as const,
    };
    const models = movePresetModel([first, second], 1, -1);
    expect(models).toEqual([second, first]);
    expect(draftToPayload({ ...EMPTY_PRESET_DRAFT, name: "P", models })).toMatchObject({
      ...second,
      models: [second, first],
    });
    expect(movePresetModel(models, 0, -1)).toEqual(models);
    expect(validateDraft({ ...EMPTY_PRESET_DRAFT, name: "P", models: [] })).toBe(
      "请至少添加一个候选模型",
    );
  });

  it("draft -> create RPC -> list -> draft is lossless", () => {
    const { board } = setupBoard();
    const draft = {
      name: "Fast",
      models: [
        { provider: "claude", model: "sonnet", thinking: "low", permissionMode: "auto" as const },
        { provider: "codex", model: "gpt", thinking: "high", permissionMode: "full" as const },
      ],
      environmentKind: "project-default" as const,
      baseBranch: "main",
      runtimeEnv: "",
      instructions: "be brief",
      fallbackPresetIds: [] as string[],
    };
    expect(validateDraft(draft)).toBeNull();
    expect(
      validateDraft({ ...draft, models: [draft.models[0]!, { ...draft.models[1]!, model: " " }] }),
    ).toBe("请选择第 2 个候选的模型");
    const { preset } = board.presets.create(draftToPayload(draft));
    const listed = board.presets.list().presets.find((p) => p.id === preset.id)!;
    expect(presetToDraft(listed)).toEqual(draft);
    const updated = board.presets.update(preset.id, draftToPayload({ ...draft, baseBranch: "" }));
    expect(updated.preset.baseBranch).toBeNull();
    board.presets.update(preset.id, { roleHints: ["scout", "reviewer"] });
    const legacy = board.presets.list().presets.find((p) => p.id === preset.id)!;
    expect(legacy.roleHints).toEqual(["scout", "reviewer"]);
    const cleared = board.presets.update(preset.id, draftToPayload(presetToDraft(legacy)));
    expect(cleared.preset.roleHints).toEqual([]);
    expect(cleared.preset.roleHint).toBeNull();
  });

  it("presets RPCs accept roleHint and reject unknown purposes and a blank model", () => {
    const base = { name: "P", provider: "claude", model: "sonnet" };
    for (const roleHint of ["worker", "scout", "reviewer", null]) {
      expect(presetsCreateRpc.input.safeParse({ ...base, roleHint }).success).toBe(true);
      expect(presetsUpdateRpc.input.safeParse({ presetId: "x", roleHint }).success).toBe(true);
    }
    expect(presetsCreateRpc.input.safeParse({ ...base, roleHint: "boss" }).success).toBe(false);
    expect(presetsCreateRpc.input.safeParse({ ...base, model: "  " }).success).toBe(false);
    expect(presetsUpdateRpc.input.safeParse({ presetId: "x", model: "" }).success).toBe(false);
  });
});

describe("WP-130 方案模型列表编辑", () => {
  it("追加、替换、移除后续前移；旧的 planner + plan_reviewer 读作列表并改写为 planners", () => {
    expect(plannersOf({ planner: "a", plan_reviewer: "b" })).toEqual(["a", "b"]);
    let value = setPlanner({ planner: "a", plan_reviewer: "b", worker: "w" }, 2, "c");
    expect(value).toEqual({ worker: "w", planners: ["a", "b", "c"] });
    value = setPlanner(value, 1, "x");
    expect(value.planners).toEqual(["a", "x", "c"]);
    value = setPlanner(value, 0, null);
    expect(value.planners).toEqual(["x", "c"]);
    value = setPlanner(setPlanner(value, 0, null), 0, null);
    expect(value).toEqual({ worker: "w" });
  });
});

describe("WP-133 任务角色", () => {
  it("表单只允许探路/复核关闭，继承清除覆盖，保存与放弃有独立基准", () => {
    const model = openDefaultsForm({ main: "m", project: "p" });
    model.change(setModelDefault(model.getState().value, "scout", DISABLED));
    expect(model.getState()).toEqual({
      value: { main: "m", project: "p", scout: null },
      dirty: true,
    });
    model.reset();
    expect(model.getState().dirty).toBe(false);
    model.change(setModelDefault(model.getState().value, "main", INHERIT));
    model.saved(model.getState().value);
    expect(model.getState()).toEqual({ value: { project: "p" }, dirty: false });
    expect(setModelDefault({}, "worker", DISABLED)).toEqual({});
    expect(cleanDefaults({ main: " m ", project: " p " })).toEqual({ main: "m", project: "p" });
  });
  it("全局及原生项目覆盖读写，未覆盖角色继续全局及主会话回退", () => {
    const { board } = setupBoard();
    const main = board.presets.create({
      name: "main",
      provider: "codex",
      model: "main-model",
    }).preset;
    const worker = board.presets.create({
      name: "worker",
      provider: "codex",
      model: "worker-model",
    }).preset;
    board.defaults.set({ main: main.id, project: main.id, worker: main.id });
    expect(getProjectDefaults(board, "native")).toEqual({
      global: { main: main.id, project: main.id, worker: main.id },
      project: {},
    });
    const result = setProjectDefaults(board, {
      projectId: "native",
      name: "Project",
      rootPath: "/project",
      defaults: { worker: worker.id, scout: null },
    });
    expect(result.project).toEqual({ worker: worker.id, scout: null });
    expect(inheritedDefaultLabel("main", result.global, () => "Main")).toBe("沿用全局：Main");
    const resolved = resolveTaskRoles({}, result.project, result.global, board.store.presets.get, {
      provider: "codex",
      model: "session",
      thinking: "high",
    });
    expect(resolved.worker.presetId).toBe(worker.id);
    expect(resolved.scout).toBeNull();
    expect(resolved.verifier.models[0]?.model).toBe("session");
    setProjectDefaults(board, {
      projectId: "native",
      name: "Project",
      rootPath: "/project",
      defaults: {},
    });
    expect(getProjectDefaults(board, "native").project).toEqual({});
    expect(board.store.projects.list(true)).toHaveLength(1);
    board.presets.delete(main.id);
    expect(board.defaults.get().global).toEqual({});
  });
  it("打开原生设置读取按路径关联的旧项目；保存失败不改变关联和其它字段", () => {
    const { board } = setupBoard();
    const p = board.presets.create({ name: "P", provider: "codex", model: "model" }).preset;
    const legacy = board.projects.create({
      name: "Legacy",
      prefix: "LEG",
      repoPath: "/legacy",
      description: "keep",
      defaultPresets: { main: p.id },
    }).project;
    expect(getProjectDefaults(board, "native", "/legacy").project).toEqual({ main: p.id });
    expect(() =>
      setProjectDefaults(board, {
        projectId: "native",
        name: "Native",
        rootPath: "/legacy",
        defaults: { main: "missing" },
      }),
    ).toThrow();
    expect(board.store.projects.get(legacy.id)?.paseoProjectId).toBeNull();
    setProjectDefaults(board, {
      projectId: "native",
      name: "Native",
      rootPath: "/legacy",
      defaults: { project: p.id },
    });
    expect(board.store.projects.get(legacy.id)).toMatchObject({
      description: "keep",
      name: "Legacy",
      paseoProjectId: "native",
      defaultPresets: { project: p.id },
    });
  });
});
