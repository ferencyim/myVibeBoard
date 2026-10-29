import { describe, expect, it } from "vitest";
import { suggestedModel } from "../client/create-model";
import { BotCreateSchema } from "../shared/vibe/contract/bots";

describe("bot 创建表单", () => {
  it("suggests a recognizable economical tier instead of a costly default", () => {
    expect(suggestedModel([{ provider: "p", models: [{ id: "opus", name: "Opus" }, { id: "mini", name: "Mini" }] }])?.model).toBe("mini");
    expect(suggestedModel([{ provider: "p", models: [{ id: "opus", name: "Opus" }] }])).toBeUndefined();
  });
  it("rejects a blank name and accepts optional profile fields", () => {
    expect(BotCreateSchema.safeParse({ kind: "independent", name: "  " }).success).toBe(false);
    expect(BotCreateSchema.safeParse({ kind: "project", projectId: "p", name: "bot", title: "", instructions: "" }).success).toBe(true);
  });
});
