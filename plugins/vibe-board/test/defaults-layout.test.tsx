// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: ({ children, testID, style }: any) => <div data-testid={testID} style={Array.isArray(style) ? Object.assign({}, ...style) : style}>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  ModelPickerField: ({ projectId }: any) => <div data-testid="model-picker" data-project-id={projectId} />,
  SettingsCard: ({ children }: any) => <div>{children}</div>,
  SettingsSection: ({ children }: any) => <section>{children}</section>,
  SettingsSelect: () => <div />,
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Modal: Object.assign(() => null, { Content: () => null }),
}));
vi.mock("../client/common/ctx", () => ({
  useHost: () => ({ theme: { colors: { foreground: "white", border: "gray" } } }),
}));
vi.mock("../client/common/ui", () => ({
  Btn: ({ label, onPress, disabled }: any) => <button onClick={onPress} disabled={disabled}>{label}</button>,
  Muted: ({ children }: any) => <span>{children}</span>,
  TextField: () => <input />,
}));
vi.mock("../client/presets/review-timeout", () => ({ ReviewTimeoutField: () => null }));

import { DefaultModelsEditor } from "../client/presets/defaults";

afterEach(cleanup);
describe("任务角色卡片", () => {
  it("方案继承提示位于方案卡片内，关闭角色仍可操作", () => {
    const onChange = vi.fn();
    render(<DefaultModelsEditor value={{}} onChange={onChange} settings={[]} providers={[]} saveRole={vi.fn()} />);
    const planner = screen.getByTestId("role-card-#2 方案 · 添加审阅模型");
    expect(within(planner).getByText("沿用 #1 模型")).toBeTruthy();
    const scout = screen.getByTestId("role-card-#3 探路");
    const disable = within(scout).getByRole("button", { name: "不启用" });
    expect(disable.parentElement?.style.borderWidth).toBe("1px");
    fireEvent.click(disable);
    expect(onChange).toHaveBeenCalledWith({ scout: null });
  });
  it("项目上下文传到主模型、备用模型和添加备用模型选择器", () => {
    const setting = {
      id: "preset", name: "角色", provider: "p", model: "m", thinking: "",
      permissionMode: "auto", environmentKind: "new-worktree", baseBranch: null,
      runtimeEnv: null, instructions: "", fallbackPresetIds: null, roleHints: [],
      roleHint: null, builtin: false, createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z", updatedHlc: "1:0:test",
      models: [
        { provider: "p", model: "m", thinking: "", permissionMode: "auto" },
        { provider: "p", model: "backup", thinking: "", permissionMode: "auto" },
      ],
    } as React.ComponentProps<typeof DefaultModelsEditor>["settings"][number];
    render(<DefaultModelsEditor projectId="project-1" value={{ main: "preset" }} onChange={vi.fn()} settings={[setting]} providers={[]} saveRole={vi.fn()} />);
    const main = screen.getByTestId("role-card-#1 主会话");
    const pickers = within(main).getAllByTestId("model-picker");
    expect(pickers).toHaveLength(3);
    for (const picker of screen.getAllByTestId("model-picker")) {
      expect(picker.dataset.projectId).toBe("project-1");
    }
  });
});
