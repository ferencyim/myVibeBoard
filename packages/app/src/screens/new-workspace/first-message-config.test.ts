import { describe, expect, it } from "vitest";
import { buildFirstMessageModel, resolveUseDefaultModel } from "./first-message-config";
import { FirstMessageOutboxInputSchema } from "@/composer/outbox/model";
describe("new task first message model", () => {
  it("offline with no provider catalog or preferences builds a valid default-model message", () => {
    const model = buildFirstMessageModel({
      composerState: null,
      formPreferences: {},
      isConnected: false,
      useDefaultModel: true,
      cwd: "/repo",
    });
    expect(model).toEqual({ modelSelection: "default" });
    expect(
      FirstMessageOutboxInputSchema.safeParse({
        id: "draft",
        hostId: "host-one",
        projectId: "project-one",
        source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
        ...model,
        text: "离线首消息",
        attachments: [],
      }).success,
    ).toBe(true);
  });
  it("default intent omits remembered concrete models while an explicit cached choice preserves them", () => {
    const input = {
      composerState: null,
      formPreferences: {
        provider: "codex",
        providerPreferences: {
          codex: { model: "cached-model", thinkingByModel: { "cached-model": "high" } },
        },
      },
      isConnected: false,
      useDefaultModel: true,
      cwd: "/repo",
    };
    expect(buildFirstMessageModel(input)).toEqual({ modelSelection: "default" });
    expect(buildFirstMessageModel({ ...input, useDefaultModel: false })).toMatchObject({
      config: { provider: "codex", model: "cached-model", thinkingOptionId: "high" },
    });
  });
});

describe("resolveUseDefaultModel", () => {
  it("shows the default when nothing concrete is selected", () => {
    expect(
      resolveUseDefaultModel({ intent: null, isConnected: true, hasSelectedModel: false }),
    ).toBe(true);
    expect(
      resolveUseDefaultModel({ intent: null, isConnected: false, hasSelectedModel: true }),
    ).toBe(true);
  });
  it("shows the saved model when connected with one selected", () => {
    expect(
      resolveUseDefaultModel({ intent: null, isConnected: true, hasSelectedModel: true }),
    ).toBe(false);
  });
  it("lets an explicit pick win", () => {
    expect(
      resolveUseDefaultModel({ intent: false, isConnected: false, hasSelectedModel: false }),
    ).toBe(false);
    expect(
      resolveUseDefaultModel({ intent: true, isConnected: true, hasSelectedModel: true }),
    ).toBe(true);
  });
});
