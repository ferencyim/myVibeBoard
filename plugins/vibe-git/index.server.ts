import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Status } from "./shared/rpc";
import { statusRpc } from "./shared/rpc";
import { createGitService, createScanState, emptyGit } from "./server/git";
import { buildStatus, releaseStatus } from "./server/dashboard";
import { createProcessRunner } from "./server/process";
import { createSingleFlight } from "./server/cache";

export default function contribute(server: PluginServerContext) {
  const scanRunner = createProcessRunner();
  const scanState = createScanState();
  const runners = new Set<ReturnType<typeof createProcessRunner>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  const service = createSingleFlight<Status>(10000, async (workspaceId) => {
    const runner = createProcessRunner();
    runners.add(runner);
    const controller = new AbortController();
    controllers.add(controller);
    let closedRequest = false;
    const gitService = createGitService(runner, scanRunner, scanState, () => !closedRequest && !closed);
    try {
      const workspace = await serverContext(workspaceId);
      const cwd = workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? "";
      const git = cwd
        ? await gitService.gitStatus(cwd).catch(() => emptyGit(cwd, "error"))
        : emptyGit(cwd, "error");
      const [build, release] = await Promise.all([
        buildStatus(cwd, git.mainPath, gitService.sourceRelation, controller.signal).catch(
          (): Status["build"] => ({ status: "error", pipelines: [] }),
        ),
        releaseStatus(git.mainPath, controller.signal).catch(
          (): Status["release"] => ({ status: "error", products: [] }),
        ),
      ]);
      return { git, build, release };
    } finally {
      closedRequest = true;
      controller.abort();
      controllers.delete(controller);
      runner.cleanup();
      runners.delete(runner);
    }
  });
  // Workspace lookup is bound to the handler context for this installation.
  let serverContext: (id: string) => Promise<import("@getpaseo/client").PaseoWorkspace | null> =
    async () => null;
  server.handle(statusRpc, ({ workspaceId, force }, context) => {
    serverContext = (id) => context.paseo.workspaces.ref(id).refresh().catch(() => null);
    return service.get(workspaceId, force);
  });
  return () => {
    closed = true;
    scanState.closed = true;
    scanState.scans.clear();
    scanRunner.cleanup();
    for (const controller of controllers) controller.abort();
    for (const runner of runners) runner.cleanup();
    service.clear();
  };
}
