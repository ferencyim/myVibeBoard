import { describe, expect, it } from "vitest";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { resolveAgentControlsMode, resolveModeControlValue, resolveNextAgentModeId } from "./mode";

const PLAN_MODE = { id: "plan", label: "Plan" } satisfies AgentMode;

const MODES = [
  PLAN_MODE,
  { id: "build", label: "Build" },
  { id: "full-access", label: "Full Access" },
] satisfies AgentMode[];

describe("resolveAgentControlsMode", () => {
  it("uses ready mode when no controlled agent controls are provided", () => {
    expect(resolveAgentControlsMode(undefined)).toBe("ready");
  });

  it("uses draft mode when controlled agent controls are provided", () => {
    expect(
      resolveAgentControlsMode({
        providerDefinitions: [],
        selectedProvider: "codex",
        modeOptions: [],
        selectedMode: "",
        onSelectMode: () => undefined,
        models: [],
        selectedModel: "",
        onSelectModel: () => undefined,
        isModelLoading: false,
        modelSelectorProviders: [],
        isAllModelsLoading: false,
        onSelectProviderAndModel: () => undefined,
        thinkingOptions: [],
        selectedThinkingOptionId: "",
        onSelectThinkingOption: () => undefined,
      }),
    ).toBe("draft");
  });
});

describe("resolveNextAgentModeId", () => {
  it("cycles from the selected mode to the next mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "build" })).toBe(
      "full-access",
    );
  });

  it("wraps from the last mode to the first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "full-access" })).toBe(
      "plan",
    );
  });

  it("treats an empty selection as the visible first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "" })).toBe("build");
  });

  it("treats a stale selection as the visible first mode", () => {
    expect(resolveNextAgentModeId({ modeOptions: MODES, selectedMode: "deleted-mode" })).toBe(
      "build",
    );
  });

  it("returns null when there are fewer than two modes", () => {
    expect(resolveNextAgentModeId({ modeOptions: [], selectedMode: "" })).toBeNull();
    expect(resolveNextAgentModeId({ modeOptions: [PLAN_MODE], selectedMode: "plan" })).toBeNull();
  });
});

describe("resolveModeControlValue", () => {
  const definition = {
    id: "claude",
    modes: MODES,
    defaultModeId: "build",
  } as unknown as Parameters<typeof resolveModeControlValue>[0]["providerDefinitions"][number];
  const base = {
    provider: "claude",
    providerDefinitions: [definition],
    currentModeId: undefined,
    onSelectMode: () => {},
    disabled: false,
  };

  it("uses the live modes when the agent reports them", () => {
    const live = [{ id: "x", label: "X" }];
    const value = resolveModeControlValue({ ...base, availableModes: live, currentModeId: "x" });
    expect(value?.modeOptions).toBe(live);
    expect(value?.selectedModeId).toBe("x");
  });

  it("falls back to the provider definition modes when the agent is not loaded", () => {
    const value = resolveModeControlValue({ ...base, availableModes: [] });
    expect(value?.modeOptions).toBe(MODES);
    expect(value?.selectedModeId).toBe("build");
  });

  it("offers nothing when neither source has modes", () => {
    expect(resolveModeControlValue({ ...base, providerDefinitions: [], availableModes: [] })).toBe(
      null,
    );
  });
});
