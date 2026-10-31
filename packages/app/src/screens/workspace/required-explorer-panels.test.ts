import { describe, expect, it } from "vitest";
import {
  conditionalPanelMatches,
  requiredExplorerTargets,
  shouldRemoveConditionalPanel,
} from "./required-explorer-panels";

describe("required explorer panels", () => {
  it("provides Git and task information before plugin queries resolve", () => {
    expect(requiredExplorerTargets({ isTask: true, botAgentId: null })).toEqual([
      { kind: "plugin", pluginId: "vibe-git", panelId: "git", context: "workspace" },
      { kind: "plugin", pluginId: "vibe-board", panelId: "task-info", context: "workspace" },
    ]);
  });
  it("provides Git and the bot profile and leaves ordinary workspaces alone", () => {
    expect(requiredExplorerTargets({ isTask: false, botAgentId: "a" })[1]).toEqual({
      kind: "plugin",
      pluginId: "vibe-bots",
      panelId: "profile",
      context: "agent",
      agentId: "a",
    });
    expect(requiredExplorerTargets({ isTask: false, botAgentId: null })).toEqual([]);
  });
});

describe("conditional explorer panels", () => {
  it("retains a previously matched panel on transient lookup failure only", () => {
    expect(conditionalPanelMatches(true, false)).toBe(true);
    expect(conditionalPanelMatches(null, true)).toBe(true);
    expect(conditionalPanelMatches(null, false)).toBe(false);
    expect(conditionalPanelMatches(false, true)).toBe(false);
  });
});

it("removes stale panels on agent switch or plugin removal, but keeps them while resolving", () => {
  const base = {
    targetAgentId: "coordinator",
    agentId: "coordinator",
    key: "maintain/rules",
    desired: [],
    pending: true,
  };
  expect(shouldRemoveConditionalPanel(base)).toBe(false);
  expect(shouldRemoveConditionalPanel({ ...base, agentId: "ordinary" })).toBe(true);
  expect(shouldRemoveConditionalPanel({ ...base, pending: false })).toBe(true);
  expect(shouldRemoveConditionalPanel({ ...base, pending: false, desired: [base.key] })).toBe(
    false,
  );
});
