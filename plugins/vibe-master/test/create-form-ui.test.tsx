// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: ({ children, style }: any) => <div data-style={JSON.stringify(style)}>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
  Pressable: ({ children, onPress, disabled, style }: any) => <button disabled={disabled} onClick={onPress} data-style={JSON.stringify(style)}>{children}</button>,
}));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { providers: [], presets: [] }, isLoading: false }) }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  Modal: Object.assign(({ children, title }: any) => <div><h1>{title}</h1>{children}</div>, { Content: ({ children }: any) => <div>{children}</div> }),
  SettingsSection: ({ children, title }: any) => <section aria-label={title}>{children}</section>,
  SettingsCard: ({ children }: any) => <div>{children}</div>,
  TextInput: ({ accessibilityLabel, value, onChangeText }: any) => <input aria-label={accessibilityLabel} value={value} onChange={(event) => onChangeText(event.target.value)} />,
  ModelPickerField: ({ onSelect }: any) => <button onClick={() => onSelect("codex", "model")}>选择模型</button>,
  SettingsSelect: () => null,
}));

import { BotCreateForm as Form } from "../client/create-form";

const theme = { colors: { foreground: "white", foregroundMuted: "gray", border: "gray", surface2: "black", accent: "blue", accentForeground: "white", statusDanger: "red" } } as any;
afterEach(cleanup);

describe("新建 bot 表单", () => {
  it("项目 bot 也使用统一标题", () => {
    render(<Form theme={theme} projectId="project" busy={false} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "新建 bot" })).toBeTruthy();
  });

  it("将字段放入有间距的卡片，右对齐次要和主操作，并校验必填项", () => {
    render(<Form theme={theme} busy={false} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "新建 bot" })).toBeTruthy();
    for (const label of ["名字", "头衔", "角色说明"]) {
      const field = screen.getByLabelText(label).parentElement!;
      expect(JSON.parse(field.dataset.style!)).toMatchObject({ gap: 6 });
      expect(field.parentElement!.closest("section")?.getAttribute("aria-label")).toBe("基本资料");
    }
    const cancel = screen.getByRole("button", { name: "取消" }) as HTMLButtonElement;
    const submit = screen.getByRole("button", { name: "新建" }) as HTMLButtonElement;
    expect(cancel.parentElement).toBe(submit.parentElement);
    expect(Array.from(submit.parentElement!.children)).toEqual([cancel, submit]);
    expect(JSON.parse(submit.parentElement!.dataset.style!)).toMatchObject({ flexDirection: "row", justifyContent: "flex-end" });
    expect(submit.disabled).toBe(true);
    expect(JSON.parse(submit.dataset.style!)).toMatchObject({ backgroundColor: "blue", opacity: 0.45 });
    fireEvent.change(screen.getByLabelText("名字"), { target: { value: "测试 bot" } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "选择模型" }));
    expect(submit.disabled).toBe(false);
    expect(JSON.parse(submit.dataset.style!)).toMatchObject({ backgroundColor: "blue", opacity: 1 });
  });
});
