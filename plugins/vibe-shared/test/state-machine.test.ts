import { describe, expect, it } from "vitest";
import { CARD_COLUMNS, SESSION_STATES, type CardColumn } from "../contract/enums";
import {
  CARD_TRANSITIONS,
  MOVE_ACTORS,
  SESSION_TRANSITIONS,
  StateMachineError,
  allowedTargets,
  assertSessionTransition,
  assertTransition,
  canCreateIn,
  canSessionTransition,
  checkTransition,
  type MoveActor,
} from "../contract/state-machine";

// The spec, written out independently of the implementation's table: from -> to -> actors.
const SPEC: Record<string, MoveActor[]> = {
  "draft>todo": ["user", "phone"],
  "todo>draft": ["user", "phone"],
  "todo>in_progress": ["dispatcher"],
  "in_progress>verifying": ["lifecycle"],
  "verifying>in_progress": ["verifier", "user", "lifecycle"],
  "verifying>done": ["user"],
};

describe("card state machine (exhaustive)", () => {
  for (const from of CARD_COLUMNS) {
    for (const to of CARD_COLUMNS) {
      for (const actor of MOVE_ACTORS) {
        const allowed = SPEC[`${from}>${to}`]?.includes(actor) ?? false;
        it(`${from} -> ${to} by ${actor}: ${allowed ? "allowed" : "rejected"}`, () => {
          const verdict = checkTransition(from, to, actor);
          expect(verdict.ok).toBe(allowed);
          if (allowed) expect(() => assertTransition(from, to, actor)).not.toThrow();
          else expect(() => assertTransition(from, to, actor)).toThrow(StateMachineError);
        });
      }
    }
  }

  it("the transition table matches the spec exactly (no extra rules)", () => {
    const table = Object.fromEntries(
      CARD_TRANSITIONS.map((t) => [`${t.from}>${t.to}`, [...t.actors].sort()]),
    );
    const spec = Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, [...v].sort()]));
    expect(table).toEqual(spec);
  });

  it("explains why a move is rejected", () => {
    expect(checkTransition("draft", "draft", "user")).toMatchObject({
      ok: false,
      reason: "same_column",
    });
    expect(checkTransition("draft", "done", "user")).toMatchObject({
      ok: false,
      reason: "illegal_transition",
    });
    expect(checkTransition("verifying", "done", "master")).toMatchObject({
      ok: false,
      reason: "actor_not_allowed",
    });
  });

  it("the master agent can never move a card", () => {
    for (const from of CARD_COLUMNS) expect(allowedTargets(from, "master")).toEqual([]);
  });

  it("the phone can only move between draft and todo", () => {
    for (const from of CARD_COLUMNS) {
      const targets = allowedTargets(from, "phone");
      if (from === "draft") expect(targets).toEqual(["todo"]);
      else if (from === "todo") expect(targets).toEqual(["draft"]);
      else expect(targets).toEqual([]);
    }
  });

  it("only the user can pass a card to done", () => {
    for (const actor of MOVE_ACTORS) {
      expect(checkTransition("verifying", "done", actor).ok).toBe(actor === "user");
    }
  });

  it("done is terminal and nothing skips verification", () => {
    for (const to of CARD_COLUMNS)
      for (const actor of MOVE_ACTORS) expect(checkTransition("done", to, actor).ok).toBe(false);
    for (const actor of MOVE_ACTORS)
      expect(checkTransition("in_progress", "done", actor).ok).toBe(false);
  });

  it("allowedTargets feeds the Move-to menu", () => {
    const t = (from: CardColumn, actor: MoveActor) => allowedTargets(from, actor);
    expect(t("draft", "user")).toEqual(["todo"]);
    expect(t("verifying", "user")).toEqual(["in_progress", "done"]);
    expect(t("in_progress", "user")).toEqual([]);
  });
});

describe("card creation rules", () => {
  it("anyone can create drafts; only users create todo; only dispatcher creates maintenance fix cards in progress", () => {
    for (const actor of MOVE_ACTORS) expect(canCreateIn("draft", "manual", actor)).toBe(true);
    expect(canCreateIn("todo", "manual", "user")).toBe(true);
    expect(canCreateIn("todo", "manual", "phone")).toBe(true);
    expect(canCreateIn("todo", "manual", "master")).toBe(false);
    expect(canCreateIn("in_progress", "maintenance", "dispatcher")).toBe(true);
    expect(canCreateIn("in_progress", "manual", "dispatcher")).toBe(false);
    expect(canCreateIn("in_progress", "maintenance", "user")).toBe(false);
    expect(canCreateIn("verifying", "maintenance", "dispatcher")).toBe(false);
    expect(canCreateIn("done", "manual", "user")).toBe(false);
  });
});

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
