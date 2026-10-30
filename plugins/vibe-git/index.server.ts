import type { PluginServerContext } from "@getpaseo/plugin/server";
import { statusRpc } from "./shared/rpc";
import { emptyGit, gitStatus } from "./server/git";
import { buildStatus, releaseStatus } from "./server/dashboard";
export default function contribute(server: PluginServerContext) {
  server.handle(statusRpc, async ({ workspaceId }, context) => {
    const workspace = await context.paseo.workspaces.ref(workspaceId).refresh().catch(() => null);
    const cwd = workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? "";
    const git = cwd ? await gitStatus(cwd).catch(() => emptyGit(cwd, "error")) : emptyGit(cwd, "error");
    const [build, release] = await Promise.all([
      buildStatus(cwd, git.mainPath).catch(() => ({ status: "error" as const, pipelines: [] })),
      releaseStatus(git.mainPath).catch(() => ({ status: "error" as const, products: [] })),
    ]);
    return { git, build, release };
  });
}

