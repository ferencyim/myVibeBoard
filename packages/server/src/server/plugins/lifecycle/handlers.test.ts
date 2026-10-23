import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";
import type { PluginTaskConversationPrepareRequest } from "@getpaseo/plugin/server";
import pino from "pino";
import { PluginRuntime } from "../runtime.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

function conversationPrepare(): PluginTaskConversationPrepareRequest {
  return {
    conversationId: "conversation",
    workspaceId: "workspace",
    ownerPluginId: "owner",
    anchorAgentId: null,
    memberId: "member",
    backendAgentId: "backend",
    recipient: { role: "planner", config: { provider: "codex", cwd: "/project" } },
    clientMessageId: "submission",
    text: "请先制定方案",
    throughSeq: 0,
    publicContext: [],
    ready: false,
  };
}

test("an unavailable owning plugin fails closed", async () => {
  const runtime = new PluginRuntime(pino({ enabled: false }), "0.12.0");
  expect(runtime.hasBefore("missing", "task.conversation.prepare")).toBe(false);
  await expect(
    runtime.before("task.conversation.prepare", conversationPrepare(), { pluginId: "missing" }),
  ).rejects.toThrow("before task.conversation.prepare is unavailable");
});

test("conversation hooks require explicit readiness and cleanup removes all registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const input = conversationPrepare();
  expect(
    await hooks.invoke("unbound", "before", "task.conversation.prepare", input, paseo),
  ).toEqual(input);
  const remove = hooks.registerTaskConversationHooks({
    prepare: ({ request }) => ({
      ...request,
      ready: true,
      config: request.recipient.config,
      context: "仅使用公开上下文",
    }),
    admit: ({ request }) => ({ ...request, admitted: true }),
    beforeControl: () => {},
  });
  const output = await hooks.invoke(
    "prepared",
    "before",
    "task.conversation.prepare",
    input,
    paseo,
  );
  expect(output).toMatchObject({ ready: true, context: "仅使用公开上下文" });
  expect(input.ready).toBe(false);
  expect(hooks.catalog().before).toEqual([
    "task.conversation.prepare",
    "task.conversation.admit",
    "task.conversation.control",
  ]);
  remove();
  remove();
  expect(hooks.catalog().before).toEqual([]);
});

test("conversation preparation cannot change its fixed source boundary or recipient", async () => {
  for (const change of [
    { throughSeq: 1 },
    { backendAgentId: "another-member" },
    { ownerPluginId: "another-owner" },
  ]) {
    const hooks = new PluginHookHandlers(() => {});
    hooks.before("task.conversation.prepare", ({ request }) => ({
      ...request,
      ...change,
      ready: true,
    }));
    await expect(
      hooks.invoke("invalid", "before", "task.conversation.prepare", conversationPrepare(), paseo),
    ).rejects.toThrow("cannot change");
  }
});

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.before("workspace.create", () => {
    return;
  });
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "before", "workspace.create", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual({ events: [], before: [] });
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env");
});
