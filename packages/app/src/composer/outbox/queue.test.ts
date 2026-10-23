import { describe, expect, it, vi } from "vitest";
import type { CreationSnapshot, WorkspaceCreateResponse } from "@getpaseo/protocol/messages";
import {
  FirstMessageOutbox,
  FIRST_MESSAGE_OUTBOX_STORAGE_KEY,
  type FirstMessageOutboxPort,
  type FirstMessageOutboxStorage,
} from "./queue";
import type { FirstMessageOutboxInput } from "./model";

function input(id = "draft-one", hostId = "host-one"): FirstMessageOutboxInput {
  return {
    id,
    hostId,
    projectId: "project-one",
    source: { kind: "worktree", projectId: "project-one", cwd: "/repo" },
    config: { provider: "codex", cwd: "/repo", model: "planning-model" },
    text: "规划一个新任务，先等我确认方案。",
    attachments: [],
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: FirstMessageOutboxStorage = {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  return { storage, values };
}

function fixture() {
  const memory = memoryStorage();
  let serial = 0;
  function queue() {
    return new FirstMessageOutbox({
      storage: memory.storage,
      now: () => 123,
      requestId: () => "intent-" + ++serial,
    });
  }
  return { ...memory, queue };
}

function snapshot(
  key = "intent-1",
  phase: CreationSnapshot["phase"] = "completed",
): CreationSnapshot {
  return {
    kind: "workspace",
    idempotencyKey: key,
    phase,
    revision: 1,
    workspaceId: "workspace-one",
    agentId: "agent-one",
    conversationId: "conversation-one",
    memberId: "planner-one",
    error: null,
  };
}

function response(creation = snapshot()): WorkspaceCreateResponse["payload"] {
  return { requestId: "wire-one", creation, workspace: null, setupTerminalId: null, error: null };
}

function port(): FirstMessageOutboxPort {
  return {
    getCreation: vi.fn(async () => null),
    prepareAttachments: vi.fn(async () => ({})),
    createWorkspace: vi.fn(async () => response()),
  };
}

describe("手机新任务首消息 outbox", () => {
  it("冷启动恢复正文、附件本机引用、主机项目和规划模型，不读取旧看板键", async () => {
    const f = fixture();
    f.values.set("vibe:old-card-replies", JSON.stringify([{ text: "不得导入" }]));
    const first = f.queue();
    const draft = input();
    draft.attachments = [
      {
        kind: "image",
        metadata: {
          id: "image-one",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "local-image-one",
          createdAt: 1,
        },
      },
    ];
    await first.enqueue(draft);
    const restarted = f.queue();
    await restarted.hydrate();
    expect(restarted.getSnapshot()).toEqual(first.getSnapshot());
    expect(restarted.getSnapshot()[0]).toMatchObject({
      ...draft,
      status: "queued",
      requestId: "intent-1",
    });
    expect(f.storage.getItem).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.storage.getItem).mock.calls.flat()).toEqual([
      FIRST_MESSAGE_OUTBOX_STORAGE_KEY,
      FIRST_MESSAGE_OUTBOX_STORAGE_KEY,
    ]);
  });

  it("只有 enqueue 持久化成功后才返回，不因磁盘失败发请求", async () => {
    const f = fixture();
    vi.mocked(f.storage.setItem).mockRejectedValueOnce(new Error("磁盘不可用"));
    const q = f.queue();
    const native = port();
    await expect(q.enqueue(input())).rejects.toThrow("磁盘不可用");
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).not.toHaveBeenCalled();
    expect(q.getSnapshot()).toHaveLength(0);
  });

  it("发送前先落盘稳定幂等键，再使用原生 create+prompt 一次完成首发", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    vi.mocked(native.createWorkspace).mockImplementation(async (request) => {
      const stored = JSON.parse(f.values.get(FIRST_MESSAGE_OUTBOX_STORAGE_KEY)!);
      expect(stored.entries[0]).toMatchObject({
        status: "sending",
        submitted: true,
        requestId: "intent-1",
      });
      expect(request).toMatchObject({
        idempotencyKey: "intent-1",
        requestId: "intent-1",
        taskConversation: {
          idempotencyKey: "intent-1",
          ownerPluginId: "vibe-board",
          initialRecipient: { role: "planner", config: input().config },
          initialMessage: {
            text: input().text,
            clientMessageId: "intent-1:initial-message",
          },
        },
      });
      expect(request.agent).toBeUndefined();
      return response();
    });
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0]).toMatchObject({
      status: "sent",
      result: {
        workspaceId: "workspace-one",
        agentId: "agent-one",
        conversationId: "conversation-one",
        memberId: "planner-one",
      },
    });
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("重复重连合并同一主机正在发送的调用，host 不串用", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    let finish!: (value: WorkspaceCreateResponse["payload"]) => void;
    vi.mocked(native.createWorkspace).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await q.enqueue(input());
    await q.enqueue(input("draft-two", "host-two"));
    const firstFlush = q.flushHost("host-one", native);
    expect(q.flushHost("host-one", native)).toBe(firstFlush);
    await vi.waitFor(() => expect(native.createWorkspace).toHaveBeenCalledTimes(1));
    finish(response());
    await firstFlush;
    expect(q.getSnapshot()[1]).toMatchObject({ hostId: "host-two", status: "queued" });
  });

  it("附件 encode 失败保留正文，不创建 workspace，用户重试后再发", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    vi.mocked(native.prepareAttachments).mockRejectedValueOnce(new Error("本机附件不存在"));
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0]).toMatchObject({
      status: "failed",
      text: input().text,
      submitted: false,
    });
    expect(native.createWorkspace).not.toHaveBeenCalled();
    await q.retry("draft-one");
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("发送前落盘失败时绝不请求主机，附件准备后的首消息仍保留", async () => {
    const f = fixture();
    const q = f.queue();
    await q.enqueue(input());
    vi.mocked(f.storage.setItem).mockRejectedValueOnce(new Error("落盘失败"));
    const native = port();
    await expect(q.flushHost("host-one", native)).rejects.toThrow("落盘失败");
    expect(native.createWorkspace).not.toHaveBeenCalled();
    expect(q.getSnapshot()[0].text).toBe(input().text);
  });

  it("创建后回执丢失，重连先查成功结果，不再次创建或发送", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    vi.mocked(native.createWorkspace).mockRejectedValueOnce(new Error("连接中断"));
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0].status).toBe("unknown");
    vi.mocked(native.getCreation).mockResolvedValue(snapshot());
    await q.flushHost("host-one", native);
    expect(native.getCreation).toHaveBeenCalledWith("intent-1");
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot()[0].status).toBe("sent");
  });

  it("创建前断线，查询确认未收到后复用同一键和 clientMessageId", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    vi.mocked(native.createWorkspace).mockRejectedValueOnce(new Error("离线"));
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    await q.flushHost("host-one", native);
    const calls = vi.mocked(native.createWorkspace).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(native.getCreation).toHaveBeenCalledTimes(1);
  });

  it("App 在创建中被杀，重启查询未完成操作并等待，完成后替换正式回执", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    vi.mocked(native.createWorkspace).mockImplementation(async () => new Promise(() => undefined));
    await q.enqueue(input());
    void q.flushHost("host-one", native);
    await vi.waitFor(() => expect(native.createWorkspace).toHaveBeenCalledTimes(1));
    const restarted = f.queue();
    const recovered = port();
    vi.mocked(recovered.getCreation).mockResolvedValueOnce(snapshot("intent-1", "agent_ready"));
    await restarted.hydrate();
    expect(restarted.getSnapshot()[0].status).toBe("unknown");
    await restarted.flushHost("host-one", recovered);
    expect(recovered.createWorkspace).not.toHaveBeenCalled();
    vi.mocked(recovered.getCreation).mockResolvedValue(snapshot());
    await restarted.flushHost("host-one", recovered);
    expect(restarted.getSnapshot()[0].status).toBe("sent");
  });

  it("结果查询失败不新建；原生不明失败即使回执后来消失也禁止盲目重放", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    vi.mocked(native.createWorkspace).mockRejectedValueOnce(new Error("超时"));
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    vi.mocked(native.getCreation).mockRejectedValueOnce(new Error("离线"));
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
    vi.mocked(native.getCreation).mockResolvedValueOnce({
      ...snapshot("intent-1", "failed"),
      outcomeUnknown: true,
      error: "未知",
    });
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0]).toMatchObject({ status: "unknown", replayBlocked: true });
    vi.mocked(native.getCreation).mockResolvedValue(null);
    await q.retry("draft-one");
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
    expect(q.getSnapshot()[0].text).toBe(input().text);
  });

  it("主机失败保留内容，重试核对同一终止回执，绝不改键新建", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    const failed = { ...snapshot("intent-1", "failed"), error: "非 Git 项目无法创建 worktree" };
    vi.mocked(native.createWorkspace).mockResolvedValue(response(failed));
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0]).toMatchObject({ status: "failed", text: input().text });
    vi.mocked(native.getCreation).mockResolvedValue(failed);
    await q.retry("draft-one");
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("拒绝离线执行命令、空输入、跨项目来源及用相同草稿 ID 替换内容", async () => {
    const q = fixture().queue();
    await expect(q.enqueue({ ...input(), text: "/执行" })).rejects.toThrow("需要联网");
    await expect(q.enqueue({ ...input(), text: " " })).rejects.toThrow("首消息");
    await expect(q.enqueue({ ...input(), projectId: "another" })).rejects.toThrow("独立 worktree");
    await q.enqueue(input());
    await q.enqueue(input());
    await expect(q.enqueue({ ...input(), text: "另一条消息" })).rejects.toThrow("不能替换");
    expect(q.getSnapshot()).toHaveLength(1);
  });

  it("原生已成功但回执落盘失败，下次重连先核对并收口，不重复创建", async () => {
    const f = fixture();
    const q = f.queue();
    const native = port();
    await q.enqueue(input());
    vi.mocked(native.createWorkspace).mockImplementation(async () => {
      vi.mocked(f.storage.setItem).mockRejectedValueOnce(new Error("回执落盘失败"));
      return response();
    });
    await expect(q.flushHost("host-one", native)).rejects.toThrow("回执落盘失败");
    vi.mocked(native.getCreation).mockResolvedValue(snapshot());
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0].status).toBe("sent");
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("其它创建操作的回执不能替换本项，也不能诱导下一次新建", async () => {
    const q = fixture().queue();
    const native = port();
    vi.mocked(native.createWorkspace).mockResolvedValue(response(snapshot("wrong-intent")));
    await q.enqueue(input());
    await q.flushHost("host-one", native);
    expect(q.getSnapshot()[0]).toMatchObject({
      status: "unknown",
      replayBlocked: true,
      result: null,
    });
    await q.flushHost("host-one", native);
    expect(native.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("损坏存储拒绝加载且不覆盖正文，不接受旧看板数据作为队列", async () => {
    const f = fixture();
    const original = JSON.stringify({ cards: [{ title: "旧积压" }] });
    f.values.set(FIRST_MESSAGE_OUTBOX_STORAGE_KEY, original);
    const q = f.queue();
    await expect(q.hydrate()).rejects.toThrow();
    await expect(q.enqueue(input())).rejects.toThrow();
    expect(f.values.get(FIRST_MESSAGE_OUTBOX_STORAGE_KEY)).toBe(original);
    expect(f.storage.setItem).not.toHaveBeenCalled();
  });

  it("订阅在持久化完成后发布；只清除已有正式回执的项", async () => {
    const q = fixture().queue();
    const listener = vi.fn();
    const stop = q.subscribe(listener);
    await q.enqueue(input());
    await q.removeSent("draft-one");
    expect(q.getSnapshot()).toHaveLength(1);
    await q.flushHost("host-one", port());
    await q.removeSent("draft-one");
    expect(q.getSnapshot()).toHaveLength(0);
    stop();
    const calls = listener.mock.calls.length;
    await q.enqueue(input("draft-two"));
    expect(listener).toHaveBeenCalledTimes(calls);
  });
});

it("目标主机缺少创建能力时保留内容并显示升级原因，不影响其它主机", async () => {
  const f = fixture();
  const q = f.queue();
  await q.enqueue(input());
  await q.enqueue(input("other", "host-two"));
  await q.failUnsubmittedHost("host-one", "请升级目标主机");
  expect(q.getSnapshot()[0]).toMatchObject({
    status: "failed",
    error: "请升级目标主机",
    text: input().text,
    submitted: false,
  });
  expect(q.getSnapshot()[1]).toMatchObject({ status: "queued", hostId: "host-two" });
});

it("群聊创建保留规划预设、附件和首消息幂等身份", async () => {
  const q = fixture().queue();
  const native = port();
  const prepared = {
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
    attachments: [{ type: "text", mimeType: "text/plain", text: "完整证据", title: "证据" }],
  } as const;
  vi.mocked(native.prepareAttachments).mockResolvedValue({
    images: [...prepared.images],
    attachments: [...prepared.attachments],
  });
  await q.enqueue({ ...input(), plannerPresetId: "selected-planner" });
  await q.flushHost("host-one", native);
  expect(native.createWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      taskConversation: {
        idempotencyKey: "intent-1",
        ownerPluginId: "vibe-board",
        initialRecipient: { role: "planner", presetId: "selected-planner", config: input().config },
        initialMessage: {
          text: input().text,
          clientMessageId: "intent-1:initial-message",
          ...prepared,
        },
      },
    }),
  );
});

it("旧的普通 agent 完成回执不能冒充任务群聊，也不能再次投递首消息", async () => {
  const q = fixture().queue();
  const native = port();
  const legacy = { ...snapshot(), conversationId: undefined, memberId: undefined };
  vi.mocked(native.createWorkspace).mockResolvedValue(response(legacy));
  await q.enqueue(input());
  await q.flushHost("host-one", native);
  expect(q.getSnapshot()[0]).toMatchObject({
    status: "failed",
    replayBlocked: true,
    result: null,
    text: input().text,
  });
  expect(q.getSnapshot()[0].error).toContain("群聊");
  await q.retry("draft-one");
  vi.mocked(native.getCreation).mockResolvedValue(legacy);
  await q.flushHost("host-one", native);
  expect(native.createWorkspace).toHaveBeenCalledTimes(1);
});

it.each(["/制定方案", "/复核方案", "/执行", "/复核", "/验证", "/通过", "/停止任务"])(
  "任务流程命令 %s 不进入离线首消息队列",
  async (text) => {
    const q = fixture().queue();
    await expect(q.enqueue({ ...input(), text })).rejects.toThrow("需要联网");
    expect(q.getSnapshot()).toHaveLength(0);
  },
);

it("升级提示没有新待发送项时不反复落盘和唤醒发送循环", async () => {
  const f = fixture();
  const q = f.queue();
  await q.enqueue(input());
  await q.failUnsubmittedHost("host-one", "请升级主机");
  const writes = vi.mocked(f.storage.setItem).mock.calls.length;
  await q.failUnsubmittedHost("host-one", "请升级主机");
  expect(f.storage.setItem).toHaveBeenCalledTimes(writes);
});
