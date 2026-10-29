import type { PaseoProject } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

interface ProjectConfigDependencies {
  callerProject(agentId: string | undefined): Promise<string>;
  project(projectId: string): Promise<PaseoProject>;
}

const ConfigInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(),
  z
    .object({
      action: z.literal("write"),
      config: z.record(z.string(), z.unknown()),
      expectedRevision: z.object({ mtimeMs: z.number(), size: z.number() }).nullable(),
    })
    .strict(),
]);

/** Configuration always belongs to the authenticated project agent's own repository. */
export function registerProjectConfigTool(
  server: PluginServerContext,
  dependencies: ProjectConfigDependencies,
) {
  server.registerAgentTool({
    name: "vibe_project_config",
    description:
      "仅项目 agent 可用：读写本项目仓库根 paseo.json，管理 worktree.setup/teardown、scripts 和 metadataGeneration。先 read 取得完整配置与 revision，保留其余字段后 write 并传 expectedRevision；遇到 stale_project_config 必须重读合并。只保存配置，不执行脚本。",
    input: ConfigInput,
    handler: async (value, { callerAgentId }) => {
      const paseo = server.paseo;
      const projectId = await dependencies.callerProject(callerAgentId ?? undefined);
      const project = await dependencies.project(projectId);
      const input = ConfigInput.parse(value);
      const repoRoot = project.projectRootPath;
      if (input.action === "read") return paseo.projects.readConfig(repoRoot);
      return paseo.projects.writeConfig({
        repoRoot,
        config: input.config,
        expectedRevision: input.expectedRevision,
      });
    },
  });
}
