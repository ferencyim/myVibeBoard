import { describe, expect, it } from "vitest";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import {
  autoModeId,
  buildPermissionOptions,
  findFastControl,
  isPickerFeature,
} from "@/components/provider-model-picker/picker-controls";

const claudeFast = (value: boolean) =>
  ({
    type: "toggle",
    id: "fast_mode",
    label: "Fast",
    value,
  }) as AgentFeature;

const codexSpeed = (value: string) =>
  ({
    type: "select",
    id: "service_tier",
    label: "Speed",
    value,
    options: [
      { id: "default", label: "Normal", isDefault: true },
      { id: "fast", label: "Fast" },
    ],
  }) as AgentFeature;

describe("findFastControl", () => {
  it("shows Claude's fast_mode toggle with its value", () => {
    expect(findFastControl([claudeFast(true)])).toEqual({
      featureId: "fast_mode",
      value: true,
      on: true,
      off: false,
    });
  });

  it("maps Codex's speed tier onto the same switch", () => {
    expect(findFastControl([codexSpeed("fast")])).toMatchObject({
      value: true,
      on: "fast",
      off: "default",
    });
    expect(findFastControl([codexSpeed("default")])).toMatchObject({ value: false });
  });

  it("is absent when the provider reports neither feature", () => {
    expect(findFastControl(undefined)).toBeNull();
    expect(findFastControl([])).toBeNull();
  });

  it("claims only the fast features for the picker", () => {
    expect(isPickerFeature("fast_mode")).toBe(true);
    expect(isPickerFeature("service_tier")).toBe(true);
    expect(isPickerFeature("plan_mode")).toBe(false);
  });
});

describe("permissions", () => {
  it("defaults to the auto tier of Claude and Codex", () => {
    expect(autoModeId("claude")).toBe("auto");
    expect(autoModeId("codex")).toBe("auto-review");
    expect(autoModeId("opencode")).toBeUndefined();
  });

  it("labels known modes in Chinese and keeps unknown ones", () => {
    expect(
      buildPermissionOptions("codex", [
        { id: "auto", label: "Default Permissions" },
        { id: "auto-review", label: "Auto-review" },
        { id: "full-access", label: "Full Access" },
      ]).map((option) => option.label),
    ).toEqual(["默认", "自动", "完全访问"]);
    expect(buildPermissionOptions("opencode", [{ id: "build", label: "Build" }])[0]?.label).toBe(
      "Build",
    );
  });
});
