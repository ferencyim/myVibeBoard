// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ coordinator: "agent-1" as string | null }));
vi.mock("react-native", () => ({ View: ({ children }: any) => <div>{children}</div>, Text: ({ children }: any) => <span>{children}</span>, ScrollView: ({ children }: any) => <div>{children}</div> }));
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: any) => queryKey[0] === "vibe-bots" ? { data: state.coordinator } : { data: { prompts: [], projects: [], orphans: [] } }, useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => vi.fn(), usePaseo: () => ({ plugins: { invoke: vi.fn() } }) }));
vi.mock("../client/common/ctx", () => ({ HostProvider: ({ children }: any) => <>{children}</>, useHost: () => ({ theme: { colors: {} } }) }));
vi.mock("../client/common/ui", () => ({ Btn: ({ label, onPress }: any) => <button onClick={onPress}>{label}</button>, Chip: () => null, Muted: ({ children }: any) => <span>{children}</span> }));
vi.mock("../client/vibe/prompts/prompt-editor", () => ({ PromptGroup: () => null }));
import { BehaviourScreen } from "../client/behaviour/BehaviourScreen";
afterEach(cleanup);
describe("自动维护入口", () => {
  it("打开总协调会话并说明面板位置", () => {
    state.coordinator = "agent-1";
    const openAgent = vi.fn(), openPluginSettings = vi.fn(), openPluginScreen = vi.fn();
    render(<BehaviourScreen {...({ theme: {}, layout: {}, navigation: { openAgent, openPluginSettings, openPluginScreen } } as any)} />);
    expect(screen.getByText(/在总协调 bot 右侧『自动维护』面板中设置/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开总协调 bot 会话" }));
    expect(openAgent).toHaveBeenCalledWith({ agentId: "agent-1" });
    expect(openPluginSettings).not.toHaveBeenCalled();
    expect(openPluginScreen).not.toHaveBeenCalled();
  });
  it("没有可用会话时仍显示说明，不显示失效链接", () => {
    state.coordinator = null;
    render(<BehaviourScreen {...({ theme: {}, layout: {}, navigation: {} } as any)} />);
    expect(screen.getByText(/在总协调 bot 右侧『自动维护』面板中设置/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开总协调 bot 会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "打开自动维护页" })).toBeNull();
  });
});
