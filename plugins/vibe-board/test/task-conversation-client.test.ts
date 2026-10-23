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
import {
  findReportEvidence,
  summarizeReport,
  summarizeTaskReport,
} from "../client/task-conversation/report-summary";

const timestamp = "2026-10-23T12:00:00.000Z";

describe("群聊验证与复核摘要", () => {
  it("普通会话、其它插件群聊和流式输出保持原样，仅本插件已完成群聊报告转换", () => {
    const input = {
      item: { text: '{"summary":"无问题","issues":[],"verdict":"pass"}' },
      phase: "complete" as const,
    };
    expect(summarizeTaskReport(input)).toBeUndefined();
    expect(
      summarizeTaskReport({
        ...input,
        taskConversation: { conversationId: "other", ownerPluginId: "other" },
      }),
    ).toBeUndefined();
    const taskConversation = { conversationId: "conversation", ownerPluginId: "vibe-board" };
    expect(summarizeTaskReport({ ...input, taskConversation, phase: "streaming" })).toBeUndefined();
    expect(summarizeTaskReport({ ...input, taskConversation })?.conclusion).toBe("通过");
  });
  it("逐项中文展示验证结论与证据，原始 JSON 和附加说明完整保留", () => {
    const raw =
      '本次独立验证\n```json\n{"summary":"共两项","items":[{"check":1,"judgement":"pass","note":"日志通过","evidence":["test.log"]},{"check":2,"judgement":"doubt","note":"缺设备","evidence":[]}]}\n```';
    expect(summarizeReport(raw, "row-1")).toEqual({
      rawText: raw,
      messageId: "row-1",
      title: "模型验证结论",
      conclusion: "存疑",
      summary: "共两项",
      checks: [
        { label: "检查项 1 · 通过", note: "日志通过", evidence: ["test.log"] },
        { label: "检查项 2 · 存疑", note: "缺设备", evidence: [] },
      ],
    });
  });

  it("复核按严重问题保守展示，保留文件行号；无问题时显示通过", () => {
    const report = summarizeReport(
      JSON.stringify({
        verdict: "pass",
        summary: "存在缺陷",
        issues: [{ severity: "severe", file: "src/a.ts", line: 12, text: "会丢数据" }],
      }),
    );
    expect(report?.conclusion).toBe("发现严重问题");
    expect(report?.checks[0]).toEqual({
      label: "问题 1 · 严重",
      note: "会丢数据\n位置：src/a.ts:12",
      evidence: [],
    });
    expect(summarizeReport('{"verdict":"pass","summary":"无问题","issues":[]}')?.conclusion).toBe(
      "通过",
    );
  });

  it("不吞掉普通 JSON、配置、损坏输出或多个报告", () => {
    for (const raw of [
      '{"items":[]}',
      '{"backend":{"requests":[]}}',
      '{"summary":"未完成","items":[',
      "普通文本",
      '```json\n{"summary":"a","items":[]}\n```\n```json\n{"summary":"b","items":[]}\n```',
    ])
      expect(summarizeReport(raw)).toBeUndefined();
  });

  it("旧报告跨页精确找源，再按该轮沉淀打开证据；不误用同名新报告", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        error: null,
        page: {
          rows: [{ id: "new", sourceKey: "new-source" }],
          hasOlder: true,
          startCursor: { epoch: "epoch", seq: 20 },
        },
      })
      .mockResolvedValueOnce({
        error: null,
        page: {
          rows: [{ id: "old", sourceKey: "old-source" }],
          hasOlder: false,
          startCursor: { epoch: "epoch", seq: 2 },
        },
      });
    const paseo = {
      taskConversations: {
        ref: () => ({
          refresh: async () => ({ ownerPluginId: "vibe-board", workspaceId: "workspace" }),
          fetch,
        }),
      },
    } as unknown as Parameters<typeof findReportEvidence>[0]["paseo"];
    const makeArtifact = (sourceKey: string, id: string) =>
      TaskArtifactSchema.parse({
        workspaceId: "workspace",
        kind: "verification",
        sourceKey,
        confirmedAt: null,
        source: { conversationId: "conversation", sourceKey },
        summary: "验证",
        data: { evidence: [{ id, path: "D:/evidence/" + id + "/test.log" }] },
        createdAt: timestamp,
        published: null,
      });
    const readArtifacts = vi.fn(async () => [
      makeArtifact("new-source", "new-file"),
      makeArtifact("old-source", "old-file"),
    ]);
    expect(
      await findReportEvidence({
        paseo,
        conversationId: "conversation",
        messageId: "old",
        name: "test.log",
        readArtifacts,
      }),
    ).toBe("old-file");
    expect(fetch).toHaveBeenNthCalledWith(2, {
      direction: "before",
      cursor: { epoch: "epoch", seq: 20 },
      limit: 500,
    });
    expect(readArtifacts).toHaveBeenCalledWith("workspace");
  });

  it("证据名称不唯一或缺少本轮沉淀时明确报错", async () => {
    const paseo = {
      taskConversations: {
        ref: () => ({
          refresh: async () => ({ ownerPluginId: "vibe-board", workspaceId: "workspace" }),
          fetch: async () => ({
            error: null,
            page: { rows: [{ id: "row", sourceKey: "source" }] },
          }),
        }),
      },
    } as unknown as Parameters<typeof findReportEvidence>[0]["paseo"];
    await expect(
      findReportEvidence({
        paseo,
        conversationId: "conversation",
        messageId: "row",
        name: "test.log",
        readArtifacts: async () => [],
      }),
    ).rejects.toThrow("此轮证据尚未沉淀");
  });
});
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
