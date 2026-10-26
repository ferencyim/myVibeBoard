import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

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

test("prompt hooks may rewrite or reject the prompt but not change its recipient", async () => {
  const input = {
    agentId: "child",
    workspaceId: "workspace",
    parentAgentId: "parent",
    callerAgentId: "parent",
    prompt: "do it",
  };
  const rewriting = new PluginHookHandlers(() => {});
  rewriting.before("agent.prompt", ({ request }) => ({ ...request, prompt: request.prompt + "!" }));
  await expect(
    rewriting.invoke("operation", "before", "agent.prompt", input, paseo),
  ).resolves.toMatchObject({ prompt: "do it!" });
  const redirecting = new PluginHookHandlers(() => {});
  redirecting.before("agent.prompt", ({ request }) => ({ ...request, agentId: "other" }));
  await expect(
    redirecting.invoke("operation", "before", "agent.prompt", input, paseo),
  ).rejects.toThrow("agent.prompt hooks can only change the prompt");
  const rejecting = new PluginHookHandlers(() => {});
  rejecting.before("agent.prompt", () => {
    throw new Error("先认领");
  });
  await expect(
    rejecting.invoke("operation", "before", "agent.prompt", input, paseo),
  ).rejects.toThrow("先认领");
});

test("permission-response hooks may reject but not change the request", async () => {
  const input = {
    agentId: "child",
    workspaceId: "workspace",
    parentAgentId: "parent",
    callerAgentId: "parent",
    requestId: "req-1",
  };
  const passing = new PluginHookHandlers(() => {});
  passing.before("agent.permission_response", () => {});
  await expect(
    passing.invoke("operation", "before", "agent.permission_response", input, paseo),
  ).resolves.toEqual(input);
  const redirecting = new PluginHookHandlers(() => {});
  redirecting.before("agent.permission_response", ({ request }) => ({
    ...request,
    requestId: "other",
  }));
  await expect(
    redirecting.invoke("operation", "before", "agent.permission_response", input, paseo),
  ).rejects.toThrow("agent.permission_response hooks can only reject");
  const rejecting = new PluginHookHandlers(() => {});
  rejecting.before("agent.permission_response", () => {
    throw new Error("审批只能由用户处理");
  });
  await expect(
    rejecting.invoke("operation", "before", "agent.permission_response", input, paseo),
  ).rejects.toThrow("审批只能由用户处理");
});
