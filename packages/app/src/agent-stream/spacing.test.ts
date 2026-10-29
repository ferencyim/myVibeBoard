import { describe, expect, it } from "vitest";
import { getAssistantMessageSpacing, getGapBetweenStreamItems } from "./spacing";
import type { StreamItem } from "@/types/stream";
const message: StreamItem = {
  kind: "assistant_message",
  id: "m",
  text: "First\n\nSecond",
  timestamp: new Date(0),
};
describe("whole-message spacing", () => {
  it("compacts only the gap to its turn footer", () => {
    expect(getAssistantMessageSpacing({ item: message })).toBe("default");
    expect(getAssistantMessageSpacing({ item: message, hasFooterBelow: true })).toBe(
      "compactBottom",
    );
  });
  it("keeps separate messages separated", () => {
    expect(getGapBetweenStreamItems(message, { ...message, id: "next" })).toBeGreaterThan(0);
  });
  it("groups adjacent user messages and tool/thought steps without joining separate turns", () => {
    const user: StreamItem = {
      kind: "user_message",
      id: "u",
      text: "hello",
      timestamp: new Date(0),
    };
    const thought: StreamItem = {
      kind: "thought",
      id: "t",
      text: "thinking",
      timestamp: new Date(0),
      status: "ready",
    };
    expect(getGapBetweenStreamItems(user, { ...user, id: "u2" })).toBeGreaterThan(0);
    expect(getGapBetweenStreamItems(thought, { ...thought, id: "t2" })).toBe(0);
    expect(getGapBetweenStreamItems(user, thought)).toBeGreaterThan(0);
  });
});
