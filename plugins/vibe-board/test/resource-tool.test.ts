import { expect, it } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerResourceTool } from "../server/resource-tool";
import { openVibeDb, migrateOwner, writeResourceMeta } from "../server/vibe/db";
it("vibe_resources returns a one-line brief and pressure reasons through its registered handler", async () => {
  const db = openVibeDb({ path: ":memory:" });
  migrateOwner(db, "core");
  let tool: Parameters<PluginServerContext["registerAgentTool"]>[0] | undefined;
  try {
    writeResourceMeta(db, "scheduler.local_resources", {
      name: "本机",
      ts: "",
      cpu: 0.34,
      totalBytes: 8 * 1024 ** 3,
      availableBytes: 1024 ** 3,
    });
    registerResourceTool(
      {
        registerAgentTool: (value) => {
          tool = value;
          return () => {};
        },
      } as Pick<PluginServerContext, "registerAgentTool">,
      db,
    );
    expect(tool?.name).toBe("vibe_resources");
    const output = await tool!.handler({}, { callerAgentId: "task-agent" } as never);
    expect(output).toMatchObject({
      briefing: "资源：本机 CPU 34% 内存余 1.0/8GB（紧张）",
      tightItems: ["本机：可用内存不足"],
    });
  } finally {
    db.close();
  }
});
