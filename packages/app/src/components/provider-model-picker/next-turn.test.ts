import { describe, expect, it } from "vitest";
import { resolveNextTurnNotice } from "./next-turn";

const base = {
  isRunning: true,
  runtimeModelId: "a",
  configuredModelId: "a",
  runtimeThinkingId: "low",
  configuredThinkingId: "low",
  labelOf: (id: string) => id.toUpperCase(),
};

describe("resolveNextTurnNotice", () => {
  it("is null when nothing changed", () => {
    expect(resolveNextTurnNotice(base)).toBeNull();
  });

  it("is null when the agent is idle", () => {
    expect(resolveNextTurnNotice({ ...base, isRunning: false, configuredModelId: "b" })).toBeNull();
  });

  it("names the running and next model", () => {
    expect(resolveNextTurnNotice({ ...base, configuredModelId: "b" })).toEqual({
      running: "A",
      next: "B",
    });
  });

  it("includes the effort when it changed", () => {
    expect(resolveNextTurnNotice({ ...base, configuredThinkingId: "high" })).toEqual({
      running: "A · low",
      next: "A · high",
    });
  });
});
