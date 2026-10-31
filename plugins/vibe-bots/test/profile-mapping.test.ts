import { describe, expect, it } from "vitest";
import {
  applyPatchToList, avatarColor, avatarInitial, backupSummary, canAddBackupModel, findBotForAgent, notificationsSummary,
  replaceBotInList, validateTextDraft, widensPermission, INSTRUCTIONS_MAX, NAME_MAX,
} from "../client/profile-mapping";

describe("bot profile mapping", () => {
  it("finds the bot owning the active main conversation", () => {
    const bots = [{ id: "a", mainAgentId: null }, { id: "b", mainAgentId: "agent-b" }];
    expect(findBotForAgent(bots, "agent-b")).toBe(bots[1]);
    expect(findBotForAgent(bots, "other")).toBeUndefined();
    expect(findBotForAgent(bots, "thread-agent", bots[0].id)).toBe(bots[0]);
  });

  it("asks for confirmation only when a permission widens", () => {
    expect(widensPermission("accept-edits", "auto")).toBe(true);
    expect(widensPermission("accept-edits", "full")).toBe(true);
    expect(widensPermission("auto", "full")).toBe(true);
    expect(widensPermission("full", "auto")).toBe(false);
    expect(widensPermission("auto", "accept-edits")).toBe(false);
    expect(widensPermission("auto", "auto")).toBe(false);
  });

  it("validates text drafts", () => {
    expect(validateTextDraft({ name: "Ada", title: "", instructions: "" })).toEqual({ name: null, title: null, instructions: null });
    expect(validateTextDraft({ name: "  ", title: "", instructions: "" }).name).toBe("名字不能为空");
    expect(validateTextDraft({ name: "x".repeat(NAME_MAX + 1), title: "", instructions: "" }).name).toContain("最多");
    expect(validateTextDraft({ name: "a", title: "x".repeat(201), instructions: "" }).title).toContain("最多");
    expect(validateTextDraft({ name: "a", title: "", instructions: "x".repeat(INSTRUCTIONS_MAX + 1) }).instructions).toContain("超出");
    expect(validateTextDraft({ name: "a", title: "", instructions: "x".repeat(INSTRUCTIONS_MAX) }).instructions).toBeNull();
  });

  it("only offers a complete, new backup model", () => {
    const existing = [{ provider: "p", model: "m", thinking: "" }];
    expect(canAddBackupModel(existing, "p", "m", "")).toBe(false);
    expect(canAddBackupModel(existing, "p", "m", "high")).toBe(true);
    expect(canAddBackupModel(existing, "", "m", "")).toBe(false);
    expect(canAddBackupModel(existing, "p", "", "")).toBe(false);
    const full = Array.from({ length: 20 }, (_, i) => ({ provider: "p", model: `m${i}`, thinking: "" }));
    expect(canAddBackupModel(full, "p", "new", "")).toBe(false);
  });

  it("summarizes rows for the settings list", () => {
    expect(backupSummary(0)).toBe("未设置");
    expect(backupSummary(3)).toBe("3 个");
    expect(notificationsSummary({ enabled: false, completed: true, failed: true })).toBe("已关闭");
    expect(notificationsSummary({ enabled: true, completed: true, failed: true })).toBe("已开启");
    expect(notificationsSummary({ enabled: true, completed: true, failed: false })).toBe("完成时");
    expect(notificationsSummary({ enabled: true, completed: false, failed: true })).toBe("失败时");
    expect(notificationsSummary({ enabled: true, completed: false, failed: false })).toBe("仅提醒");
  });

  it("applies and replaces a bot in a list without touching the others", () => {
    const a = { id: "a", name: "A", hue: 1 };
    const b = { id: "b", name: "B", hue: 2 };
    const patched = applyPatchToList([a, b], "a", { name: "A2" });
    expect(patched[0]).toEqual({ id: "a", name: "A2", hue: 1 });
    expect(patched[1]).toBe(b);
    const restored = applyPatchToList(patched, "a", { name: "A" });
    expect(restored[0]).toEqual(a);
    expect(replaceBotInList([a, b], { id: "b", name: "B3", hue: 9 })[1].name).toBe("B3");
    expect(replaceBotInList([a], { id: "zzz", name: "?", hue: 0 })).toEqual([a]);
  });

  it("derives avatar initial and color", () => {
    expect(avatarInitial("  ada")).toBe("A");
    expect(avatarInitial("")).toBe("?");
    expect(avatarColor(-30)).toBe("hsl(330, 48%, 32%)");
  });
});
