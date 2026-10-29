import { describe, expect, it } from "vitest";
import { modelChoices, suggestedModel } from "../client/create-model";
import { BotCreateSchema } from "../shared/vibe/contract/bots";

describe("bot 创建表单", () => {
  it("suggests a recognizable economical tier instead of a costly default", () => {
    expect(suggestedModel([{ provider: "p", models: [{ id: "opus", name: "Opus" }, { id: "mini", name: "Mini" }] }])?.model).toBe("mini");
    expect(suggestedModel([{ provider: "p", models: [{ id: "opus", name: "Opus" }] }])).toBeUndefined();
  });
  it("derives model options from the selected cached provider without mutating it", () => {
    const models = Object.freeze([{ id: "m1", name: "Model 1" }, { id: "m2", name: "Model 2" }]);
    expect(modelChoices(models)).toEqual([{ label: "请选择模型", value: "" }, { label: "Model 1", value: "m1" }, { label: "Model 2", value: "m2" }]);
    expect(modelChoices(undefined)).toEqual([{ label: "请选择模型", value: "" }]);
  });
  it("rejects a blank name and accepts optional profile fields", () => {
    expect(BotCreateSchema.safeParse({ kind: "independent", name: "  " }).success).toBe(false);
    expect(BotCreateSchema.safeParse({ kind: "project", projectId: "p", name: "bot", title: "", instructions: "" }).success).toBe(true);
  });
});
