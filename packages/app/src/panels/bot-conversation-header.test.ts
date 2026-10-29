import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  conversationBotQueryKey,
  findConversationBot,
  isProfileTarget,
} from "./bot-conversation-header";

describe("conversation bot identity", () => {
  it("matches only the bot's main agent", () => {
    const bots = [{ mainAgentId: null }, { mainAgentId: "agent-a" }, { mainAgentId: "agent-b" }];
    expect(findConversationBot(bots, "agent-b")).toBe(bots[2]);
    expect(findConversationBot(bots, "other")).toBeUndefined();
  });

  it("invalidates the saved host's identity without invalidating another host", async () => {
    const first = conversationBotQueryKey("host-a");
    const second = conversationBotQueryKey("host-b");
    const hostA = new QueryClient();
    const hostB = new QueryClient();
    hostA.setQueryData(first, [{ name: "old" }]);
    hostB.setQueryData(second, [{ name: "other" }]);
    await hostA.invalidateQueries({ queryKey: ["vibe-bots"], refetchType: "none" });
    expect(hostA.getQueryState(first)?.isInvalidated).toBe(true);
    expect(hostB.getQueryState(second)?.isInvalidated).toBe(false);
  });

  it("only treats the current agent profile as the open profile", () => {
    const target = {
      kind: "plugin",
      context: "agent",
      pluginId: "vibe-bots",
      panelId: "profile",
      agentId: "a",
    } as const;
    expect(isProfileTarget(target, "a")).toBe(true);
    expect(isProfileTarget(target, "b")).toBe(false);
    expect(isProfileTarget({ ...target, panelId: "other" }, "a")).toBe(false);
  });
});
