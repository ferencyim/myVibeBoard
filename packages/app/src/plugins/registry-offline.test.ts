import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import { invokeConnectedPluginRpc } from "./rpc";

function connectedHost() {
  const calls: Array<{ pluginId: string; method: string; input: unknown }> = [];
  const client: Pick<DaemonClient, "invokePluginRpc"> = {
    async invokePluginRpc(pluginId, method, input) {
      calls.push({ pluginId, method, input });
      return { saved: true };
    },
  };
  return { client, calls };
}

describe("plugin RPC online boundary", () => {
  it.each([
    "vibe.presets.update",
    "vibe.prompts.set",
    "vibe.task.confirm",
    "vibe.reply.send",
    "vibe.task.stop",
    "vibe.cards.create",
  ])("rejects offline %s without local success or queueing", async (method) => {
    await expect(invokeConnectedPluginRpc(null, "vibe-board", method, {})).rejects.toThrow(
      "[offline] 主机未连接；设置、确认、审批和停止操作须联网后重试",
    );
  });

  it("forwards only to the exact connected host and plugin", async () => {
    const hostA = connectedHost();
    const hostB = connectedHost();
    await expect(
      invokeConnectedPluginRpc(hostB.client, "vibe-board", "vibe.task.confirm", {
        workspaceId: "workspace",
      }),
    ).resolves.toEqual({ saved: true });
    expect(hostA.calls).toEqual([]);
    expect(hostB.calls).toEqual([
      { pluginId: "vibe-board", method: "vibe.task.confirm", input: { workspaceId: "workspace" } },
    ]);
  });

  it("does not retain a disconnected operation to replay after reconnect", async () => {
    const host = connectedHost();
    await expect(
      invokeConnectedPluginRpc(null, "vibe-board", "vibe.task.confirm", {
        workspaceId: "workspace",
      }),
    ).rejects.toThrow("须联网后重试");
    await invokeConnectedPluginRpc(host.client, "vibe-board", "vibe.projects.list", {});
    expect(host.calls).toEqual([
      { pluginId: "vibe-board", method: "vibe.projects.list", input: {} },
    ]);
  });

  it("returns an online transport failure to the caller", async () => {
    const client: Pick<DaemonClient, "invokePluginRpc"> = {
      async invokePluginRpc() {
        throw new Error("连接已断开");
      },
    };
    await expect(
      invokeConnectedPluginRpc(client, "vibe-board", "vibe.task.confirm", {}),
    ).rejects.toThrow("连接已断开");
  });
});
