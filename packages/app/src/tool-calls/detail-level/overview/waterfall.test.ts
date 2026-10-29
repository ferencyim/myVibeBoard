import { expect, it } from "vitest";
import type { StepItem } from "../grouping";
import { waterfallScrollTarget, waterfallStepIds } from "./waterfall";

it("retains source IDs and order for waterfall navigation", () => {
  const steps: StepItem[] = [
    { kind: "thought", id: "thinking", text: "thinking", status: "ready", timestamp: new Date(0) },
    {
      kind: "tool_call",
      id: "tool",
      timestamp: new Date(1),
      payload: {
        source: "orchestrator",
        data: {
          toolCallId: "call",
          toolName: "Shell",
          arguments: "",
          result: null,
          status: "completed",
        },
      },
    },
  ];
  expect(waterfallStepIds(steps)).toEqual(["thinking", "tool"]);
});

it("waits for a selected step to be measured instead of scrolling to the latest step", () => {
  expect(waterfallScrollTarget("tool", null)).toBe("wait");
  expect(waterfallScrollTarget("tool", 120)).toBe(120);
  expect(waterfallScrollTarget(null, null)).toBe("latest");
});
