import { describe, expect, it } from "vitest";
import { workspaceWindowTitle } from "./workspace-header-source";

describe("workspaceWindowTitle", () => {
  it("uses project and task or bot names, and defaults on ordinary pages", () => {
    expect(workspaceWindowTitle("项目", "任务")).toBe("myVibeBoard - 项目/任务");
    expect(workspaceWindowTitle("项目", "bot")).toBe("myVibeBoard - 项目/bot");
    expect(workspaceWindowTitle("", null)).toBe("myVibeBoard");
  });
});
