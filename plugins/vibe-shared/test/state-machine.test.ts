import { describe, expect, it } from "vitest";
import { SESSION_STATES } from "../contract/enums";
import {
  assertSessionTransition,
  canSessionTransition,
  SESSION_TRANSITIONS,
  StateMachineError,
} from "../contract/state-machine";
describe("session state machine", () => {
  it("matches the transition table for every pair", () => {
    for (const from of SESSION_STATES) {
      for (const to of SESSION_STATES) {
        const expected = from === to || SESSION_TRANSITIONS[from].includes(to);
        expect(canSessionTransition(from, to)).toBe(expected);
      }
    }
  });

  it("ended is terminal; error can recover to working", () => {
    for (const to of SESSION_STATES)
      if (to !== "ended") expect(canSessionTransition("ended", to)).toBe(false);
    expect(canSessionTransition("error", "working")).toBe(true);
    expect(() => assertSessionTransition("ended", "working")).toThrow(StateMachineError);
    expect(canSessionTransition("starting", "waiting")).toBe(true);
    expect(canSessionTransition("working", "starting")).toBe(false);
  });
});
