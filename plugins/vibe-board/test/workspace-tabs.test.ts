import { describe, expect, it } from "vitest";
import { taskWorkspaceTabs } from "../client/workspace-tabs";
import type { TaskTabViewData } from "../shared/task-tabs";

function roleTab(role: TaskTabViewData["role"], number: number): TaskTabViewData {
  return {
    role, number, agentId: "", roleLabel: role, provider: "codex", model: "default-model",
    status: "未启动", title: null, busy: false,
  };
}

describe("task workspace placeholders", () => {
  it("keeps every role and its resolved setup before agents exist", () => {
    const tabs = [roleTab("main", 1), roleTab("planner", 2), roleTab("scout", 3),
      roleTab("worker", 4), roleTab("reviewer", 5), roleTab("verifier", 6)];
    tabs[0]!.agentId = "main-agent";
    tabs[2]!.status = "未启用";
    const result = taskWorkspaceTabs(tabs);
    expect(result).toHaveLength(6);
    expect(result.map((tab) => tab.order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result[0]!.agentId).toBe("main-agent");
    expect(result[2]!.disabled).toBe(true);
    expect(result[3]!.setup).toEqual({ provider: "codex", model: "default-model" });
  });

  it("sorts fixed roles and exposes their model and status", () => {
    const worker = roleTab("worker", 4);
    worker.status = "排队";
    const scout = roleTab("scout", 3);
    scout.status = "未启用";
    const result = taskWorkspaceTabs([worker, scout]);
    expect(result.map((tab) => tab.order)).toEqual([3, 4]);
    expect(result[0]!.title).toContain("本流程未启用");
    expect(result[1]!.title).toContain("default-model · 排队");
  });

  it("keeps status visible for existing agents", () => {
    const worker = roleTab("worker", 4);
    worker.agentId = "worker-agent";
    worker.status = "运行中";
    expect(taskWorkspaceTabs([worker])[0]!.title).toContain("default-model · 忙碌");
    worker.status = "待审批";
    expect(taskWorkspaceTabs([worker])[0]!.title).toContain("default-model · 待审批");
  });

  it("uses raw model IDs and leaves unresolved models for the composer to select", () => {
    const tab = roleTab("worker", 4);
    tab.model = "模型显示名";
    tab.modelId = "raw-model-id";
    expect(taskWorkspaceTabs([tab])[0]!.setup?.model).toBe("raw-model-id");
    tab.modelId = "未解析";
    expect(taskWorkspaceTabs([tab])[0]!.setup?.model).toBeUndefined();
  });

});
