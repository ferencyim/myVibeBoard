import { describe, expect, it } from "vitest";
import { findBotForAgent } from "../client/profile-mapping";

describe("bot profile mapping", () => {
  it("finds the bot owning the active main conversation", () => {
    const bots = [{ id: "a", mainAgentId: null }, { id: "b", mainAgentId: "agent-b" }];
    expect(findBotForAgent(bots, "agent-b")).toBe(bots[1]);
    expect(findBotForAgent(bots, "other")).toBeUndefined();
  });
});
