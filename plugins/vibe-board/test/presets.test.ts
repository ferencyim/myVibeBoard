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
