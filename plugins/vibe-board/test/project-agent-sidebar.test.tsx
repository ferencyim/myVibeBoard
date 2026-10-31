import { describe, expect, it, vi } from "vitest";
import type { ProjectAgentState } from "../shared/project-agent";
import {
  createProjectAgentRequest,
  deactivateProjectAgentRequest,
  openProjectAgentRequest,
  projectAgentPollInterval,
  projectAgentPresentation,
  projectBotListPollInterval,
  projectBotWorkspaceProjection,
  receiveProjectAgentState,
} from "../client/project-agent-sidebar";

const idle: ProjectAgentState = { status: "idle", agentId: null, workspaceId: null, error: null };
const creating: ProjectAgentState = { ...idle, status: "creating" };
const ready: ProjectAgentState = {
  status: "ready", agentId: "project-agent", workspaceId: "workspace", error: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function sidebar(id = "project", displayName = "项目 agent") {
  let state = idle;
  let opening = false;
  let error: string | null = null;
  const request = createProjectAgentRequest(id, displayName);
  const openAgent = vi.fn();
  const ports = {
    cancelQueries: vi.fn(async () => {}),
    open: vi.fn(async (_projectId: string) => creating),
    setState: vi.fn((result: ProjectAgentState) => { state = result; }),
    setOpening: (value: boolean) => { opening = value; },
    setError: (value: string | null) => { error = value; },
    openAgent,
  };
  return {
    request, ports, openAgent,
    presentation: () => projectAgentPresentation(state, opening, error, displayName),
    interval: () => projectAgentPollInterval(state),
    open: () => openProjectAgentRequest(request, ports),
    receive(result: ProjectAgentState) {
      state = result;
      receiveProjectAgentState(request, result, openAgent);
    },
    unmount: () => deactivateProjectAgentRequest(request),
  };
}

describe("项目 agent 侧栏创建流程", () => {
  it("多个项目 bot 分别轮询和导航，失败只影响对应行", async () => {
    const first = sidebar("bot-one", "默认 bot");
    const second = sidebar("bot-two", "审阅 bot");
    await Promise.all([first.open(), second.open()]);
    expect(first.ports.open).toHaveBeenCalledExactlyOnceWith("bot-one");
    expect(second.ports.open).toHaveBeenCalledExactlyOnceWith("bot-two");
    expect(first.presentation().label).toBe("正在创建…");
    expect(second.presentation().label).toBe("正在创建…");
    expect(first.interval()).toBe(1_000);
    expect(second.interval()).toBe(1_000);
    first.receive({ ...idle, status: "failed", error: "创建 bot 失败，请重试。" });
    expect(first.presentation()).toEqual({ label: "重试打开默认 bot", error: "创建 bot 失败，请重试。", disabled: false });
    second.receive({ ...ready, agentId: "agent-two" });
    expect(second.openAgent).toHaveBeenCalledExactlyOnceWith("agent-two");
    expect(first.openAgent).not.toHaveBeenCalled();
    first.ports.open.mockResolvedValue({ ...ready, agentId: "agent-one" });
    await first.open();
    expect(first.openAgent).toHaveBeenCalledExactlyOnceWith("agent-one");
  });
  it("已知主对话 agent 时点击立即导航，RPC 在后台且不重复导航", async () => {
    const fast = sidebar("bot-fast");
    const gate = deferred<ProjectAgentState>();
    fast.ports.open.mockReturnValue(gate.promise);
    const run = openProjectAgentRequest(fast.request, { ...fast.ports, knownAgentId: "main" });
    expect(fast.openAgent).toHaveBeenCalledExactlyOnceWith("main");
    expect(fast.presentation().disabled).toBe(false);
    gate.resolve({ ...ready, agentId: "main" });
    await run;
    expect(fast.openAgent).toHaveBeenCalledOnce();
  });
  it("立即显示创建中，轮询完成后只打开一次", async () => {
    const view = sidebar();
    expect(view.interval()).toBe(60_000);
    const pending = view.open();
    expect(view.presentation()).toEqual({ label: "正在打开项目 agent…", error: null, disabled: true });
    await view.open();
    await pending;
    expect(view.ports.cancelQueries).toHaveBeenCalledOnce();
    expect(view.ports.open).toHaveBeenCalledExactlyOnceWith("project");
    expect(view.presentation()).toEqual({ label: "正在创建项目 agent…", error: null, disabled: true });
    expect(view.interval()).toBe(1_000);
    expect(view.openAgent).not.toHaveBeenCalled();
    view.receive(creating);
    expect(view.interval()).toBe(1_000);
    expect(view.openAgent).not.toHaveBeenCalled();
    view.receive(ready);
    expect(view.openAgent).toHaveBeenCalledExactlyOnceWith("project-agent");
    expect(view.interval()).toBe(60_000);
    view.receive(ready);
    expect(view.openAgent).toHaveBeenCalledOnce();
  });

  it("创建失败显示中文原因，重试后自动打开", async () => {
    const view = sidebar();
    await view.open();
    view.receive({ ...idle, status: "failed", error: "创建项目 agent 失败，请重试。" });
    expect(view.presentation()).toEqual({
      label: "重试打开项目 agent", error: "创建项目 agent 失败，请重试。", disabled: false,
    });
    expect(view.interval()).toBe(60_000);
    view.receive(ready);
    expect(view.openAgent).not.toHaveBeenCalled();
    view.ports.open.mockResolvedValue(ready);
    await view.open();
    expect(view.openAgent).toHaveBeenCalledExactlyOnceWith("project-agent");
    expect(view.ports.open).toHaveBeenCalledTimes(2);
    expect(view.presentation()).toEqual({ label: "项目 agent", error: null, disabled: false });
  });

  it("RPC 失败显示中文提示并允许重试", async () => {
    const view = sidebar();
    view.ports.open.mockRejectedValueOnce(new Error("transport timeout"));
    await view.open();
    expect(view.presentation()).toEqual({
      label: "重试打开项目 agent", error: "暂时无法打开项目 agent，请重试。", disabled: false,
    });
    view.ports.open.mockResolvedValue(ready);
    await view.open();
    expect(view.openAgent).toHaveBeenCalledExactlyOnceWith("project-agent");
    expect(view.ports.open).toHaveBeenCalledTimes(2);
    expect(view.presentation()).toEqual({ label: "项目 agent", error: null, disabled: false });
  });

  it("卸载后未完成的 open 不触发导航", async () => {
    const finish = deferred<ProjectAgentState>();
    const view = sidebar();
    view.ports.open.mockReturnValueOnce(finish.promise);
    const pending = view.open();
    await Promise.resolve();
    expect(view.ports.open).toHaveBeenCalledOnce();
    view.unmount();
    finish.resolve(ready);
    await pending;
    view.receive(ready);
    expect(view.openAgent).not.toHaveBeenCalled();
    expect(view.ports.setState).not.toHaveBeenCalled();
  });

  it("切换项目后旧项目的 open 不触发导航", async () => {
    const finish = deferred<ProjectAgentState>();
    const previous = sidebar();
    previous.ports.open.mockReturnValueOnce(finish.promise);
    const pending = previous.open();
    await Promise.resolve();
    expect(previous.ports.open).toHaveBeenCalledOnce();
    previous.unmount();
    const current = sidebar();
    current.request.projectId = "other-project";
    finish.resolve(ready);
    await pending;
    previous.receive(ready);
    expect(previous.openAgent).not.toHaveBeenCalled();
    expect(previous.ports.setState).not.toHaveBeenCalled();
    expect(current.openAgent).not.toHaveBeenCalled();
    expect(current.presentation()).toEqual({ label: "项目 agent", error: null, disabled: false });
    current.ports.open.mockResolvedValue(ready);
    await current.open();
    expect(current.ports.open).toHaveBeenCalledExactlyOnceWith("other-project");
    expect(current.openAgent).toHaveBeenCalledExactlyOnceWith("project-agent");
  });
});

it("列表采用较低的后台刷新频率", () => {
  expect(projectBotListPollInterval).toBe(60_000);
});

it("projects only listed bot workspaces and propagates failed lookups", async () => {
  const read = vi.fn(async (id: string) => ({ workspaceId: id === "a" ? "workspace" : "foreign" }));
  await expect(projectBotWorkspaceProjection(["a", "b"], ["workspace"], read)).resolves.toEqual([{ workspaceId: "workspace", kind: "bot" }]);
  await expect(projectBotWorkspaceProjection(["a"], ["workspace"], async () => { throw new Error("offline"); })).rejects.toThrow("offline");
});
