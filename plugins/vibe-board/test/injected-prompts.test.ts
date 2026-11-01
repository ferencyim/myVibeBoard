import { describe, expect, it } from "vitest";
import { injectedPromptKeys, ownPromptKeys } from "../client/injected-prompts";

const ALL = [
  "task.role.main", "task.plan_format", "board.tabs.guide", "board.tabs.history_notice",
  "board.task.continuation", "context.inject_frame", "context.cold_start", "board.scout.ask",
  "task.role.scout", "project.agent.role", "project.agent.task_done", "master.rules", "master.repair_json",
];

describe("injectedPromptKeys", () => {
  it("lists a task tab's role prompts before the shared ones and skips unregistered keys", () => {
    expect(injectedPromptKeys({ tabRole: "main" }, ALL)).toEqual([
      "task.role.main", "task.plan_format", "board.tabs.guide", "board.tabs.history_notice",
      "board.task.continuation", "context.inject_frame", "context.cold_start",
    ]);
    expect(ownPromptKeys({ tabRole: "main" }, ALL)).toEqual(new Set(["task.role.main", "task.plan_format"]));
  });
  it("gives a project bot its own prompts and no task-tab ones", () => {
    const keys = injectedPromptKeys({ labels: { "vibe.role": "project" } }, ALL);
    expect(keys.slice(0, 2)).toEqual(["project.agent.role", "project.agent.task_done"]);
    expect(keys).not.toContain("board.tabs.guide");
  });
  it("gives the master agent every registered master prompt", () => {
    expect(injectedPromptKeys({ labels: { role: "master" } }, ALL).slice(0, 2)).toEqual(["master.rules", "master.repair_json"]);
  });
  it("shows only the shared context prompts for other agents", () => {
    expect(injectedPromptKeys({}, ALL)).toEqual(["context.inject_frame", "context.cold_start"]);
  });
});
