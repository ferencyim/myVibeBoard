import { beforeEach, describe, expect, it } from "vitest";
import {
  desktopWindowTitle,
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
