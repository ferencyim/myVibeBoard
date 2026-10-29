import { describe, expect, it, vi } from "vitest";
import { submitWorkspaceTabMessage } from "./workspace-tab-submission";
import type { PluginWorkspaceTabProvider } from "@getpaseo/plugin/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

describe("submitWorkspaceTabMessage", () => {
  it("creates the role then sends the original first message as a native user", async () => {
    const calls: string[] = [];
    const create = vi.fn(async () => {
      calls.push("create");
      return { agentId: "worker" };
    });
    const fetchAgent = vi.fn(async () => ({
      agent: { id: "worker", provider: "test", model: "selected" },
    }));
    const sendAgentMessage = vi.fn(
      async (_agentId: string, _text: string, _options: Record<string, unknown>) => {
        calls.push("send");
        return {};
      },
    );
    const provider = {
      id: "flow",
      resolve: async () => [],
      create,
    } satisfies PluginWorkspaceTabProvider;
    await submitWorkspaceTabMessage({
      provider,
      workspaceId: "task",
      tabId: "worker",
      config: { provider: "test", model: "selected" },
      client: { fetchAgent, sendAgentMessage } as unknown as Pick<
        DaemonClient,
        "fetchAgent" | "sendAgentMessage" | "setAgentModel" | "setAgentThinkingOption"
      >,
      text: "开始执行",
      options: { messageId: "first-message" },
    });
    expect(calls).toEqual(["create", "send"]);
    expect(create).toHaveBeenCalledWith({
      workspaceId: "task",
      tabId: "worker",
      provider: "test",
      model: "selected",
    });
    expect(sendAgentMessage).toHaveBeenCalledWith("worker", "开始执行", {
      messageId: "first-message",
    });
    expect(sendAgentMessage.mock.calls[0]?.[2]).not.toHaveProperty("sourceAgentId");
  });

  it("applies the selected model when background provisioning won the race", async () => {
    const setAgentModel = vi.fn(async () => {});
    const setAgentThinkingOption = vi.fn(async () => {});
    const sendAgentMessage = vi.fn(async () => ({}));
    const agent = await submitWorkspaceTabMessage({
      provider: {
        id: "flow",
        resolve: async () => [],
        create: async () => ({ agentId: "worker" }),
      },
      workspaceId: "task",
      tabId: "worker",
      config: { provider: "test", model: "chosen", thinkingOptionId: "high" },
      client: {
        fetchAgent: vi.fn(async () => ({
          agent: { id: "worker", provider: "test", model: "old" },
        })),
        setAgentModel,
        setAgentThinkingOption,
        sendAgentMessage,
      } as unknown as Pick<
        DaemonClient,
        "fetchAgent" | "sendAgentMessage" | "setAgentModel" | "setAgentThinkingOption"
      >,
      text: "开始执行",
      options: { messageId: "first-message" },
    });
    expect(setAgentModel).toHaveBeenCalledWith("worker", "chosen");
    expect(setAgentThinkingOption).toHaveBeenCalledWith("worker", "high");
    expect(sendAgentMessage).toHaveBeenCalledOnce();
    expect(agent).toMatchObject({ model: "chosen", thinkingOptionId: "high" });
  });

  it("preserves the message when role creation fails", async () => {
    const sendAgentMessage = vi.fn();
    await expect(
      submitWorkspaceTabMessage({
        provider: {
          id: "flow",
          resolve: async () => [],
          create: async () => {
            throw new Error("模型不可用");
          },
        },
        workspaceId: "task",
        tabId: "worker",
        config: { provider: "test" },
        client: { fetchAgent: vi.fn(), sendAgentMessage } as unknown as Pick<
          DaemonClient,
          "fetchAgent" | "sendAgentMessage" | "setAgentModel" | "setAgentThinkingOption"
        >,
        text: "开始执行",
        options: { messageId: "first-message" },
      }),
    ).rejects.toThrow("模型不可用");
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });
});
