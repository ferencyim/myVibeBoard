import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import type { TaskConversationSnapshot } from "@getpaseo/protocol/messages";
import { createTaskPanelReader, readTaskCachePolicy } from "../server/task-panel";
import { openBoardRuntime } from "../server/service";
import { createTaskHost } from "../server/task-host";
import { setContextMeta } from "../server/vibe/db";

const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
function setup() {
  const runtime = openBoardRuntime({ path: ":memory:" });
  closes.push(() => runtime.close());
  const preset = runtime.store.presets.create({
    name: "完整预设",
    provider: "codex",
    model: "cheap",
    roleHint: "worker",
    permissionMode: "full",
  });
  runtime.store.modelDefaults.setGlobal({
    planner: preset.id,
    worker: preset.id,
    verifier: preset.id,
  });
  const conversation: TaskConversationSnapshot = {
    conversationId: "conversation",
    workspaceId: "workspace",
    anchorAgentId: "anchor",
    ownerPluginId: "vibe-board",
    status: "active",
    epoch: "epoch",
    lastSeq: 0,
    members: [],
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
  };
  const workspace = {
    workspaceKind: "worktree",
    projectKind: "git",
    workspaceDirectory: process.cwd(),
    projectRootPath: process.cwd() + "/main",
  };
  const paseo = {
    taskConversations: { ref: () => ({ refresh: async () => conversation }) },
    workspaces: {
      ref: () => ({
        directory: process.cwd(),
        projectId: "project",
        refresh: async () => workspace,
      }),
    },
  } as unknown as PaseoApi;
  const host = createTaskHost({ ...runtime, paseo: () => paseo });
  return {
    ...runtime,
    conversation,
    workspace,
    paseo,
    read: createTaskPanelReader({ ...runtime, resolveRecipient: host.resolveRecipient }),
  };
}
it("binds an existing container and offers full presets across seven roles without creating members", async () => {
  const ctx = setup();
  const result = await ctx.read(
    { workspaceId: "workspace", conversationId: "conversation" },
    ctx.paseo,
  );
  expect(result.task).toMatchObject({ phase: "planning", conversationId: "conversation" });
  expect(result.recipients.filter((option) => !option.id.endsWith(":default"))).toHaveLength(7);
  expect(
    result.recipients.find((option) => option.role === "planner")?.recipient.config.providerOptions,
  ).toMatchObject({ sandbox_mode: "read-only", approval_policy: "never" });
  expect(result.members).toEqual([]);
  expect(result.suggestedRecipientId).toBe("planner:default");
});
it.each(["checkout", "local_checkout", "directory"])(
  "rejects %s workspaces before binding a task",
  async (kind) => {
    const ctx = setup();
    ctx.workspace.workspaceKind = kind;
    await expect(
      ctx.read({ workspaceId: "workspace", conversationId: "conversation" }, ctx.paseo),
    ).rejects.toThrow("附加 Git worktree");
    expect(ctx.store.tasks.list()).toEqual([]);
  },
);
it("rejects a main checkout incorrectly declared as a worktree", async () => {
  const ctx = setup();
  const samePath = ctx.workspace.workspaceDirectory.replace(/\\/g, "/") + "/.";
  ctx.workspace.projectRootPath = process.platform === "win32" ? samePath.toUpperCase() : samePath;
  await expect(
    ctx.read({ workspaceId: "workspace", conversationId: "conversation" }, ctx.paseo),
  ).rejects.toThrow("项目主检出");
  expect(ctx.store.tasks.list()).toEqual([]);
});
it("rejects foreign conversation/workspace or owner before exposing task data", async () => {
  const ctx = setup();
  ctx.conversation.workspaceId = "other";
  await expect(
    ctx.read({ workspaceId: "workspace", conversationId: "conversation" }, ctx.paseo),
  ).rejects.toThrow("不属于");
  expect(ctx.store.tasks.list()).toEqual([]);
  ctx.conversation.workspaceId = "workspace";
  ctx.conversation.ownerPluginId = "other";
  await expect(
    ctx.read({ workspaceId: "workspace", conversationId: "conversation" }, ctx.paseo),
  ).rejects.toThrow("不属于");
});
it("reads the context owner's configured TTL and automatic switch with schema defaults", () => {
  const ctx = setup();
  expect(readTaskCachePolicy(ctx.db)).toMatchObject({
    ttlSecondsByProvider: { codex: 300 },
    autoCompact: true,
  });
  setContextMeta(
    ctx.db,
    "context:compaction_policy",
    JSON.stringify({ ttlSeconds: { codex: 42 }, fallbackTtlSeconds: 99, enabled: false }),
  );
  expect(readTaskCachePolicy(ctx.db)).toMatchObject({
    ttlSecondsByProvider: { codex: 42, claude: 3600 },
    fallbackTtlSeconds: 99,
    autoCompact: false,
  });
});
