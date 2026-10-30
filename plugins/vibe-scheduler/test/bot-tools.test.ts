import { describe, expect, it } from "vitest";
import { requireIndependentBot } from "../server/bot-tools";

describe("bot 调度工具权限", () => {
  it("仅接受总协调 bot 主对话，不接受普通独立 bot、项目 bot 或旧会话", async () => {
    const calls: unknown[][] = [];
    async function invoke(pluginId: string, method: string, input: unknown) {
      calls.push([pluginId, method, input]);
      return {
        bots: [
          { mainAgentId: "master-main", role: "coordinator" },
          { mainAgentId: "general-main", role: null },
        ],
      };
    }
    await expect(requireIndependentBot("master-main", invoke)).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["vibe-bots", "bots.list", { kind: "independent" }]);
    await expect(requireIndependentBot("general-main", invoke)).rejects.toThrow("总协调");
    await expect(requireIndependentBot("project-main", invoke)).rejects.toThrow("bot");
    await expect(requireIndependentBot("previous-master", invoke)).rejects.toThrow("bot");
    await expect(requireIndependentBot(null, invoke)).rejects.toThrow("bot");
    expect(calls).toHaveLength(4);
  });
});
