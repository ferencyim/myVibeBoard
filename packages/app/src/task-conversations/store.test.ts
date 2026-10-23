import { beforeEach, describe, expect, it } from "vitest";
import type {
  TaskConversationPage,
  TaskConversationRow,
  TaskConversationMember,
} from "@getpaseo/protocol/messages";
import type { SubagentRow } from "@/subagents/select";
import { createUserMessage } from "@/types/stream";
import {
  clearTaskConversationRecipients,
  setTaskConversationRecipient,
  useTaskConversationSelectionStore,
} from "@/composer/task-conversation-selection";
import { projectTaskConversationRows, selectTaskConversationChildren } from "./projection";
import {
  createTaskConversationSubmissionWriter,
  emptyTaskConversationTimeline,
  mergeTaskConversationPage,
  taskConversationKey,
  useTaskConversationStore,
} from "./store";

function row(seq: number, updatedSeq = seq): TaskConversationRow {
  return {
    id: `row-${seq}`,
    epoch: "epoch",
    seq,
    updatedSeq,
    sourceKey: `source-${seq}`,
    kind: "assistant",
    text: `消息${updatedSeq}`,
    createdAt: "2026-10-23T12:00:00Z",
  };
}
function page(
  rows: TaskConversationRow[],
  start: number,
  end: number,
  hasNewer = false,
): TaskConversationPage {
  return {
    conversationId: "conversation",
    epoch: "epoch",
    rows,
    startCursor: { epoch: "epoch", seq: start },
    endCursor: { epoch: "epoch", seq: end },
    hasOlder: start > 1,
    hasNewer,
    sourceSeqRanges: [{ start, end }],
  };
}

beforeEach(() =>
  useTaskConversationStore.setState({ conversations: new Map(), timelines: new Map() }),
);

describe("task conversation replica", () => {
  it("lists only explicit managed children while retaining provider child sessions", () => {
    const member = (memberId: string, parentMemberId?: string): TaskConversationMember => ({
      memberId,
      backendAgentId: `agent-${memberId}`,
      role: "same-role",
      config: { provider: "codex", cwd: "/repo", model: "cheap" },
      parentMemberId,
      seenConversationSeq: 0,
      lastRequestAt: null,
      status: "idle",
    });
    const members = [
      member("anchor"),
      member("main"),
      member("permission"),
      member("child-1", "main"),
      member("child-2", "main"),
      member("other-child", "other"),
    ];
    const rows: SubagentRow[] = members.map((candidate) => ({
      kind: "paseo",
      id: candidate.backendAgentId,
      provider: "codex",
      title: null,
      description: null,
      subtitle: null,
      status: "idle",
      turn: { phase: "idle", cancellationRequestId: null },
      requiresAttention: false,
      createdAt: new Date(0),
    }));
    const provider: SubagentRow = {
      kind: "provider",
      id: "provider-child",
      parentAgentId: "agent-main",
      provider: "codex",
      title: "Explore",
      description: null,
      subtitle: null,
      status: "running",
      requiresAttention: false,
      createdAt: new Date(0),
    };
    rows.push(provider);
    expect(selectTaskConversationChildren(rows, "main", members).map((child) => child.id)).toEqual([
      "agent-child-1",
      "agent-child-2",
      "provider-child",
    ]);
    expect(selectTaskConversationChildren(rows, "anchor", members)).toEqual([provider]);
  });
  it("retains the exact selected member when siblings share role and model", () => {
    const config = { provider: "claude" as const, cwd: "/repo", model: "cheap" };
    setTaskConversationRecipient("host", "member-selection", {
      memberId: "first-child",
      role: "subagent",
      config,
      parentMemberId: "parent",
    });
    setTaskConversationRecipient("host", "member-selection", {
      memberId: "second-child",
      role: "subagent",
      config,
      parentMemberId: "parent",
    });
    const selected = useTaskConversationSelectionStore
      .getState()
      .selections.get(taskConversationKey("host", "member-selection"))?.recipient;
    expect(selected).toEqual({
      memberId: "second-child",
      role: "subagent",
      config,
      parentMemberId: "parent",
    });
    clearTaskConversationRecipients("host", "member-selection");
  });
  it("advances event coverage while preserving a fixed assistant position and newer text", () => {
    const initial = mergeTaskConversationPage(
      emptyTaskConversationTimeline(),
      page([row(1), row(2)], 1, 2),
      "tail",
    );
    const updated = mergeTaskConversationPage(initial, page([row(1, 4), row(3)], 3, 4), "after");
    expect(updated.rows.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(updated.endSeq).toBe(4);
    expect(updated.rows[0].text).toBe("消息4");
    const olderReplay = mergeTaskConversationPage(updated, page([row(1)], 1, 1), "before");
    expect(olderReplay.rows[0].text).toBe("消息4");
  });
  it("refuses a discontiguous page and retains the readable history", () => {
    const initial = mergeTaskConversationPage(
      emptyTaskConversationTimeline(),
      page([row(1)], 1, 1),
      "tail",
    );
    const next = mergeTaskConversationPage(initial, page([row(5)], 5, 5), "after");
    expect(next.rows).toBe(initial.rows);
    expect(next.needsRefresh).toBe(true);
  });
  it("does not certify a new epoch from an older in-flight pagination request", () => {
    const initial = mergeTaskConversationPage(
      emptyTaskConversationTimeline(),
      page([row(5)], 5, 5),
      "tail",
    );
    const different = { ...page([row(1)], 1, 1), epoch: "rewound" };
    const next = mergeTaskConversationPage(initial, different, "before");
    expect(next.rows).toBe(initial.rows);
    expect(next.needsRefresh).toBe(true);
  });
  it("uses event sequence for live gaps, then merges a replacement at its original position", () => {
    const store = useTaskConversationStore.getState();
    store.applyPage("host", page([row(1), row(2)], 1, 2), "tail");
    store.applyRow("host", "conversation", row(1, 4), 4);
    let timeline = useTaskConversationStore
      .getState()
      .timelines.get(taskConversationKey("host", "conversation"));
    expect(timeline?.needsRefresh).toBe(true);
    expect(timeline?.endSeq).toBe(2);
    store.applyPage("host", page([row(3), row(1, 4)], 3, 4), "after");
    timeline = useTaskConversationStore
      .getState()
      .timelines.get(taskConversationKey("host", "conversation"));
    expect(timeline?.endSeq).toBe(4);
    expect(timeline?.rows.map((item) => item.id)).toEqual(["row-1", "row-2", "row-3"]);
  });
  it("keeps attachment presentation and unknown delivery after canonical acknowledgement", () => {
    const writer = createTaskConversationSubmissionWriter("host");
    const submitted = createUserMessage({
      id: "local",
      clientMessageId: "client",
      text: "任务",
      timestamp: new Date("2026-10-23T12:00:00Z"),
      images: [
        {
          id: "image",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "image",
          createdAt: 1,
        },
      ],
    });
    writer.begin("conversation", submitted);
    const store = useTaskConversationStore.getState();
    store.setUncertain("host", "conversation", "client", "结果不明");
    const canonical: TaskConversationRow = {
      ...row(1),
      kind: "user",
      clientMessageId: "client",
      text: "任务",
    };
    store.applyPage("host", page([canonical], 1, 1), "tail");
    writer.accept("conversation", "client");
    const state = useTaskConversationStore
      .getState()
      .timelines.get(taskConversationKey("host", "conversation"));
    expect(state?.submissions).toEqual([]);
    expect(state?.uncertain.get("client")).toBe("结果不明");
    const projected = projectTaskConversationRows(state?.rows ?? [], state?.submittedRows ?? []);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      id: "local",
      kind: "user_message",
      images: submitted.images,
    });
  });
  it("keeps owing catch-up when a later live gap arrives during an older response", () => {
    const store = useTaskConversationStore.getState();
    store.applyPage("host", page([row(1)], 1, 1), "tail");
    store.applyRow("host", "conversation", row(5), 5);
    store.applyPage("host", page([row(2), row(3)], 2, 3), "after");
    const partial = useTaskConversationStore
      .getState()
      .timelines.get(taskConversationKey("host", "conversation"));
    expect(partial?.needsRefresh).toBe(true);
    expect(partial?.sync).toBe("loading");
    store.applyPage("host", page([row(4), row(5)], 4, 5), "after");
    const complete = useTaskConversationStore
      .getState()
      .timelines.get(taskConversationKey("host", "conversation"));
    expect(complete?.needsRefresh).toBe(false);
    expect(complete?.endSeq).toBe(5);
  });
});
