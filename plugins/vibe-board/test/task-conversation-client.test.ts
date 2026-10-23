import { describe, expect, it, vi } from "vitest";
import {
  TaskConversationPanelSchema,
  type TaskConversationPanelSnapshot,
} from "../shared/task-conversation";
import {
  actionAvailable,
  resolveArtifactChatSourceKey,
  loadArtifactContent,
  selectTaskRecipient,
  cacheRemainingSeconds,
  formatCountdown,
  recipientMember,
  recipientOptions,
  suggestedRole,
  TASK_ACTIONS,
} from "../client/task-conversation/logic";
import { TaskArtifactSchema, TaskSchema } from "../shared/vibe/contract";

const timestamp = "2026-10-23T12:00:00.000Z";
function snapshot(): TaskConversationPanelSnapshot {
  return TaskConversationPanelSchema.parse({
    task: null,
    blockers: [],
    subtasks: [],
    artifacts: [],
    recipients: [
      {
        id: "planner:p1",
        label: "规划 · 便宜模型",
        role: "planner",
        presetId: "p1",
        recipient: {
          role: "planner",
          presetId: "p1",
          config: { provider: "codex", model: "model-1", cwd: "/task" },
        },
      },
      {
        id: "worker:p1",
        label: "执行 · 便宜模型",
        role: "worker",
        presetId: "p1",
        recipient: {
          role: "worker",
          presetId: "p1",
          config: { provider: "codex", model: "model-1", cwd: "/task" },
        },
      },
    ],
    members: [
      {
        memberId: "old-planner",
        backendAgentId: "old-agent",
        role: "planner",
        presetId: "p1",
        provider: "codex",
        model: "model-1",
        lastRequestAt: "2026-10-23T11:00:00.000Z",
        status: "idle",
      },
      {
        memberId: "planner",
        backendAgentId: "agent",
        role: "planner",
        presetId: "p1",
        provider: "codex",
        model: "model-1",
        lastRequestAt: timestamp,
        status: "idle",
      },
      {
        memberId: "worker",
        backendAgentId: "worker-agent",
        role: "worker",
        presetId: "p1",
        provider: "codex",
        model: "model-1",
        lastRequestAt: null,
        status: "idle",
      },
    ],
    cache: { ttlSecondsByProvider: { codex: 300 }, fallbackTtlSeconds: 60, autoCompact: true },
  });
}

describe("任务面板与群聊命令", () => {
  it("确认前先保存 worker 任务预设才切接手者，确认后不改冻结默认", async () => {
    const value = snapshot();
    value.task = TaskSchema.parse({
      workspaceId: "workspace",
      anchorAgentId: "anchor",
      phase: "planning",
      plan: null,
      confirmedAt: null,
      rolesSnapshot: null,
      subtaskRuns: [],
      summary: "",
    });
    const saveRole = vi.fn(async () => {});
    const select = vi.fn();
    await selectTaskRecipient({ snapshot: value, id: "worker:p1", saveRole, select });
    expect(saveRole).toHaveBeenCalledWith("worker", { mode: "preset", presetId: "p1" });
    expect(select).toHaveBeenCalledWith("worker:p1");
    expect(saveRole.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
    value.task.phase = "executing";
    await selectTaskRecipient({ snapshot: value, id: "planner:p1", saveRole, select });
    expect(saveRole).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenLastCalledWith("planner:p1");
  });

  it("任务预设保存失败不伪装选择成功；默认选项明确恢复inherit", async () => {
    const value = snapshot();
    value.task = TaskSchema.parse({
      workspaceId: "workspace",
      anchorAgentId: "anchor",
      phase: "awaiting_confirmation",
      plan: null,
      confirmedAt: null,
      rolesSnapshot: null,
      subtaskRuns: [],
      summary: "",
    });
    value.recipients.push({ ...value.recipients[0]!, id: "planner:default" });
    const saveRole = vi.fn(async () => {
      throw new Error("离线");
    });
    const select = vi.fn();
    await expect(
      selectTaskRecipient({ snapshot: value, id: "planner:default", saveRole, select }),
    ).rejects.toThrow("离线");
    expect(saveRole).toHaveBeenCalledWith("planner", { mode: "inherit" });
    expect(select).not.toHaveBeenCalled();
  });

  it("探路等完整内容按宿主源读取，源失败明确报错，结构化证据不重复读聊天", async () => {
    const artifact = TaskArtifactSchema.parse({
      workspaceId: "workspace",
      kind: "scout",
      sourceKey: "source",
      confirmedAt: null,
      source: { conversationId: "conversation", sourceKey: "source", memberId: "scout" },
      summary: "探路摘要",
      data: null,
      createdAt: timestamp,
      published: null,
    });
    const querySource = vi.fn(async () => ({
      error: null as string | null,
      row: { text: "完整探路结论".repeat(1000) } as { text: string } | null,
    }));
    const ref = vi.fn(() => ({ querySource }));
    const paseo = { taskConversations: { ref } } as unknown as Parameters<
      typeof loadArtifactContent
    >[0];
    expect(await loadArtifactContent(paseo, artifact)).toBe("完整探路结论".repeat(1000));
    expect(ref).toHaveBeenCalledWith("conversation");
    expect(querySource).toHaveBeenCalledWith({ sourceKey: "source" });
    querySource.mockResolvedValueOnce({ error: "源读取失败", row: null });
    await expect(loadArtifactContent(paseo, artifact)).rejects.toThrow("源读取失败");
    artifact.data = { evidence: "可查报告" };
    expect(await loadArtifactContent(paseo, artifact)).toContain("可查报告");
    expect(querySource).toHaveBeenCalledTimes(2);
  });

  it("原始公开源存在时精确定位原发言，不依赖成员元数据或发布行", async () => {
    const artifact = TaskArtifactSchema.parse({
      workspaceId: "workspace",
      kind: "git",
      sourceKey: "git:request",
      confirmedAt: null,
      source: { conversationId: "conversation", sourceKey: "model:turn" },
      summary: "Git 收尾结果",
      data: { status: "completed" },
      createdAt: timestamp,
      published: null,
    });
    const querySource = vi.fn(async () => ({ error: null, row: { sourceKey: "model:turn" } }));
    const paseo = { taskConversations: { ref: () => ({ querySource }) } } as unknown as Parameters<
      typeof resolveArtifactChatSourceKey
    >[0];
    expect(await resolveArtifactChatSourceKey(paseo, artifact)).toBe("model:turn");
    expect(querySource).toHaveBeenCalledExactlyOnceWith({ sourceKey: "model:turn" });
  });

  it.each(["review", "verification"] as const)(
    "旧%s有成员但synthetic源不存在时按发布cursor定位",
    async (kind) => {
      const sourceKey = "verification:run" + (kind === "review" ? ":review" : "");
      const artifact = TaskArtifactSchema.parse({
        workspaceId: "workspace",
        kind,
        sourceKey,
        confirmedAt: null,
        source: {
          conversationId: "conversation",
          sourceKey,
          memberId: "native-member",
          backendAgentId: "native-agent",
          epoch: "provider-epoch",
          seq: 39,
        },
        summary: "已完成报告",
        data: { report: "完整报告保留" },
        createdAt: timestamp,
        published: { epoch: "conversation-epoch", seq: 101 },
      });
      const publishedKey = `task-artifact:${kind}:${sourceKey}`;
      const querySource = vi.fn(
        async (input: { sourceKey?: string; cursor?: { epoch: string; seq: number } }) => ({
          error: null,
          row: input.cursor ? { sourceKey: publishedKey } : null,
        }),
      );
      const paseo = {
        taskConversations: { ref: () => ({ querySource }) },
      } as unknown as Parameters<typeof resolveArtifactChatSourceKey>[0];
      expect(await resolveArtifactChatSourceKey(paseo, artifact)).toBe(publishedKey);
      expect(querySource).toHaveBeenNthCalledWith(1, { sourceKey });
      expect(querySource).toHaveBeenNthCalledWith(2, { cursor: artifact.published });
      expect(artifact.data).toEqual({ report: "完整报告保留" });
    },
  );

  it("源读取出错时明确失败，不把网络错误误当作源缺失", async () => {
    const artifact = TaskArtifactSchema.parse({
      workspaceId: "workspace",
      kind: "git",
      sourceKey: "git:request",
      confirmedAt: null,
      source: { conversationId: "conversation", sourceKey: "git:request" },
      summary: "Git 结果",
      data: {},
      createdAt: timestamp,
      published: { epoch: "epoch", seq: 1 },
    });
    const querySource = vi.fn(async () => ({ error: "断线", row: null }));
    const paseo = { taskConversations: { ref: () => ({ querySource }) } } as unknown as Parameters<
      typeof resolveArtifactChatSourceKey
    >[0];
    await expect(resolveArtifactChatSourceKey(paseo, artifact)).rejects.toThrow("断线");
    expect(querySource).toHaveBeenCalledTimes(1);
  });

  it("只提供七个显式流程命令，普通赞同不是命令", () => {
    expect(TASK_ACTIONS.map((entry) => entry.command)).toEqual([
      "制定方案",
      "复核方案",
      "执行",
      "复核",
      "验证",
      "通过",
      "停止任务",
    ]);
    expect(TASK_ACTIONS.find((entry) => entry.command === "执行")?.action).toBe("execute");
    expect(TASK_ACTIONS.find((entry) => entry.command === "通过")?.action).toBe("accept");
  });

  it("执行与通过按钮提示匹配授权阶段，验证仍为必经步骤", () => {
    expect(actionAvailable("execute", "planning")).toBe(true);
    expect(actionAvailable("execute", "executing")).toBe(false);
    expect(actionAvailable("accept", "verifying")).toBe(false);
    expect(actionAvailable("accept", "awaiting_acceptance")).toBe(true);
    expect(actionAvailable("verify", "reviewing")).toBe(true);
    expect(actionAvailable("reject", "awaiting_acceptance")).toBe(true);
    expect(actionAvailable("execute", undefined)).toBe(false);
  });

  it("建议接手者随阶段变化，选择本身不产生授权", () => {
    expect(suggestedRole("planning")).toBe("planner");
    expect(suggestedRole("awaiting_confirmation")).toBe("planner");
    expect(suggestedRole("executing")).toBe("worker");
    expect(suggestedRole("verifying")).toBe("verifier");
  });
});

describe("提示缓存估算", () => {
  it("使用最后请求时间和provider时长，向上取秒并正确到期", () => {
    expect(cacheRemainingSeconds(timestamp, 300, Date.parse(timestamp) + 999)).toBe(300);
    expect(cacheRemainingSeconds(timestamp, 300, Date.parse(timestamp) + 120000)).toBe(180);
    expect(cacheRemainingSeconds(timestamp, 300, Date.parse(timestamp) + 301000)).toBe(0);
    expect(cacheRemainingSeconds(null, 300, Date.now())).toBe(null);
    expect(cacheRemainingSeconds("bad-date", 300, Date.now())).toBe(null);
    expect(formatCountdown(61)).toBe("1分01秒");
    expect(formatCountdown(0)).toContain("估计已到期");
  });

  it("同模型不同角色不混用缓存，使用最近一次匹配成员", () => {
    const value = snapshot();
    expect(recipientMember(value, "planner:p1")?.memberId).toBe("planner");
    expect(recipientMember(value, "worker:p1")?.memberId).toBe("worker");
    expect(recipientMember(value, "unknown")).toBeUndefined();
    const options = recipientOptions(value);
    expect(options[0]?.cacheExpiresAt).toBe(Date.parse(timestamp) + 300000);
    expect(options[1]?.cacheExpiresAt).toBeNull();
    expect(options[0]?.recipient).toEqual(value.recipients[0]?.recipient);
  });

  it("provider配置缺失时使用上下文服务给出的fallback", () => {
    const value = snapshot();
    value.cache.ttlSecondsByProvider = {};
    expect(recipientOptions(value)[0]?.cacheExpiresAt).toBe(Date.parse(timestamp) + 60000);
  });

  it("明确选回旧成员时，不混用同配置新成员的缓存", () => {
    const value = snapshot();
    const option = value.recipients[0]!;
    value.recipients.push({
      ...option,
      id: "member:old-planner",
      recipient: { ...option.recipient, memberId: "old-planner" },
    });
    expect(recipientMember(value, "member:old-planner")?.memberId).toBe("old-planner");
    expect(recipientOptions(value).at(-1)?.cacheExpiresAt).toBe(
      Date.parse("2026-10-23T11:00:00.000Z") + 300000,
    );
  });
});
