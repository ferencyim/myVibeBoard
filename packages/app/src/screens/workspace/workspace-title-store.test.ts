import { beforeEach, describe, expect, it } from "vitest";
import {
  desktopWindowTitle,
  resolveWorkspaceTitle,
  useWorkspaceTitleStore,
  workspaceTitleSuffix,
} from "./workspace-title-store";

beforeEach(() => useWorkspaceTitleStore.setState({ owner: null, suffix: null }));

describe("desktop workspace title", () => {
  it("uses the product name with a task or bot and restores it on exit", () => {
    const owner = Symbol();
    const store = useWorkspaceTitleStore.getState();
    store.setTitle(owner, workspaceTitleSuffix("项目", "任务"));
    expect(desktopWindowTitle("myVibeBoard", useWorkspaceTitleStore.getState().suffix)).toBe(
      "myVibeBoard - 项目/任务",
    );
    store.setTitle(owner, workspaceTitleSuffix("项目", "bot"));
    expect(desktopWindowTitle("产品", useWorkspaceTitleStore.getState().suffix)).toBe(
      "产品 - 项目/bot",
    );
    store.clearTitle(owner);
    expect(desktopWindowTitle("myVibeBoard", useWorkspaceTitleStore.getState().suffix)).toBe(
      "myVibeBoard",
    );
  });

  it("does not let a departing workspace clear the next workspace title", () => {
    const previous = Symbol();
    const current = Symbol();
    const store = useWorkspaceTitleStore.getState();
    store.setTitle(previous, "项目/旧任务");
    store.setTitle(current, "项目/新任务");
    store.clearTitle(previous);
    expect(useWorkspaceTitleStore.getState().suffix).toBe("项目/新任务");
  });
});

describe("workspace title identity", () => {
  it.each([
    [
      {
        isTask: false,
        taskName: null,
        bot: { name: "总协调", kind: "independent" as const, projectId: null },
        sessionName: "会话",
        projectName: "bot_内部目录",
      },
      "总协调",
    ],
    [
      {
        isTask: false,
        taskName: null,
        bot: { name: "助手", kind: "project" as const, projectId: "p" },
        sessionName: "会话",
        projectName: "项目",
      },
      "项目/助手",
    ],
    [
      { isTask: true, taskName: "任务", bot: undefined, sessionName: "会话", projectName: "项目" },
      "项目/任务",
    ],
    [
      {
        isTask: false,
        taskName: null,
        bot: undefined,
        sessionName: "普通会话",
        projectName: "目录",
      },
      "普通会话",
    ],
    [
      { isTask: true, taskName: "任务", bot: undefined, sessionName: "会话", projectName: null },
      "任务",
    ],
  ])("resolves identity without directory or ID fallbacks", (input, expected) => {
    const { project, name } = resolveWorkspaceTitle(input);
    expect(workspaceTitleSuffix(project, name)).toBe(expected);
  });
});
