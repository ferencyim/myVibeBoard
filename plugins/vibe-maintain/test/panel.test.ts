import { describe, expect, it } from "vitest";
import { isCoordinatorConversation } from "../client/panel-mapping";

describe("总协调维护面板", () => {
  it("只匹配总协调的主对话和旁线程", () => {
    const bots = [{ id: "coordinator", role: "coordinator", mainAgentId: "main" }, { id: "other", role: "general", mainAgentId: "other-main" }];
    expect(isCoordinatorConversation(bots, "main")).toBe(true);
    expect(isCoordinatorConversation(bots, "thread", "coordinator")).toBe(true);
    expect(isCoordinatorConversation(bots, "other-main")).toBe(false);
    expect(isCoordinatorConversation(bots, "thread", "other")).toBe(false);
  });
});
