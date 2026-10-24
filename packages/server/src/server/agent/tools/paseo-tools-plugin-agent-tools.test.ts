import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

async function catalogDependencies() {
  const logger = createTestLogger();
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-plugin-tools-"));
  return {
    logger,
    dependencies: {
      agentManager: new AgentManager({ logger }),
      agentStorage: new AgentStorage(paseoHome, logger),
      providerSnapshotManager: new ProviderSnapshotManager({ logger }),
      logger,
    },
  };
}

test("plugin agent tools receive the caller identity and create_agent drops asTab", async () => {
  const { logger: _logger, dependencies } = await catalogDependencies();
  const calls: Array<{ pluginId: string; name: string; input: unknown; callerAgentId: string }> =
    [];
  const catalog = createPaseoToolCatalog({
    ...dependencies,
    callerAgentId: "caller-agent",
    listPluginAgentTools: () => [
      {
        pluginId: "vibe-board",
        name: "vibe_probe",
        description: "Probe the caller identity",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    ],
    invokePluginAgentTool: async (pluginId, name, input, callerAgentId) => {
      calls.push({ pluginId, name, input, callerAgentId });
      return { ok: true };
    },
  });

  await expect(catalog.executeTool("vibe_probe", { value: "hello" })).resolves.toMatchObject({
    structuredContent: { ok: true },
  });
  expect(calls).toEqual([
    {
      pluginId: "vibe-board",
      name: "vibe_probe",
      input: { value: "hello" },
      callerAgentId: "caller-agent",
    },
  ]);

  const createAgent = catalog.getTool("create_agent");
  expect(createAgent).toBeDefined();
  const schema = z.toJSONSchema(createAgent!.inputSchema as z.ZodType, {
    io: "input",
  }) as { properties: Record<string, unknown> };
  expect(schema.properties).not.toHaveProperty("asTab");
});

test("plugin agent tools are hidden from top-level catalogs without a caller agent", async () => {
  const { dependencies } = await catalogDependencies();
  const catalog = createPaseoToolCatalog({
    ...dependencies,
    listPluginAgentTools: () => [
      {
        pluginId: "vibe-board",
        name: "vibe_probe",
        description: "Probe the caller identity",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    invokePluginAgentTool: async () => {
      throw new Error("Unexpected plugin tool invocation");
    },
  });

  expect(catalog.getTool("vibe_probe")).toBeUndefined();
});
