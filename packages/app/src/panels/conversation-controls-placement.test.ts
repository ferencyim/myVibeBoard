import { describe, expect, it } from "vitest";
import { conversationControlsPlacement } from "./conversation-controls-placement";

describe("conversation control placement", () => {
  it("keeps exactly one live control owner across layouts", () => {
    expect(conversationControlsPlacement(false, false, false)).toBe("header");
    expect(conversationControlsPlacement(true, false, false)).toBe("registration");
    expect(conversationControlsPlacement(true, false, true)).toBe("runtime");
    expect(conversationControlsPlacement(false, true, false)).toBe("composer");
    expect(conversationControlsPlacement(true, true, true)).toBe("composer");
  });
});
