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
  const deadlines = new Set<() => void>();
  let closed = false;
  const service = createSingleFlight<Status>(10000, async (workspaceId) => {
    const runner = createProcessRunner();
    runners.add(runner);
    const controller = new AbortController();
    controllers.add(controller);
    let expired = false;
    const gitService = createGitService(runner, scanRunner, scanState, () => !expired && !closed);
    let cwd = "";
    let git = emptyGit(cwd, "error");
    let build: Status["build"] = { status: "dashboard_down", pipelines: [] };
    let release: Status["release"] = { status: "dashboard_down", products: [] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopDeadline: (() => void) | undefined;
    const work = (async () => {
      const workspace = await serverContext(workspaceId);
      if (expired || closed) return;
      cwd = workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? "";
      git = cwd
        ? await gitService.gitStatus(cwd).catch(() => emptyGit(cwd, "error"))
        : emptyGit(cwd, "error");
      if (expired || closed) return;
      await Promise.all([
        buildStatus(cwd, git.mainPath, gitService.sourceRelation, controller.signal)
          .then((value) => { build = value; })
          .catch(() => { build = { status: "error", pipelines: [] }; }),
        releaseStatus(git.mainPath, controller.signal)
          .then((value) => { release = value; })
          .catch(() => { release = { status: "error", products: [] }; }),
      ]);
    })();
    try {
      await Promise.race([work, new Promise<void>((resolve) => {
        stopDeadline = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        deadlines.add(stopDeadline);
        timer = setTimeout(stopDeadline, 2900);
      })]);
      return { git, build, release };
    } finally {
      expired = true;
      if (timer) clearTimeout(timer);
      if (stopDeadline) deadlines.delete(stopDeadline);
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
    for (const stop of deadlines) stop();
    for (const controller of controllers) controller.abort();
    for (const runner of runners) runner.cleanup();
    service.clear();
  };
}
