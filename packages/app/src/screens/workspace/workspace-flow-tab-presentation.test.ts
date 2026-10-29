import { describe, expect, it } from "vitest";
import { presentWorkspaceFlowTab } from "./workspace-flow-tab-presentation";

describe("流程 tab 展示", () => {
  it("保留短标题和完整提示，并显示状态徽标", () => {
    expect(presentWorkspaceFlowTab("#2 方案 · 模型甲 · 空闲", false, "running")).toEqual({
      label: "#2 方案",
      tooltip: "#2 方案 · 模型甲 · 忙碌",
      disabled: false,
      statusBucket: "running",
    });
  });

  it("只有标题时保留标题", () => {
    expect(presentWorkspaceFlowTab("#1 群聊", false, "running").label).toBe("#1 群聊");
    expect(presentWorkspaceFlowTab("#1 群聊", false, "running").tooltip).toBe("#1 群聊");
  });

  it("未启用档位在提示中说明可启用", () => {
    expect(presentWorkspaceFlowTab("#3 探路 · 模型乙 · 本流程未启用", true, null)).toEqual({
      label: "#3 探路",
      tooltip: "#3 探路 · 模型乙 · 本流程未启用 · 点击启用",
      disabled: true,
      statusBucket: null,
    });
  });
});
