import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Status } from "./shared/rpc";
import { statusRpc } from "./shared/rpc";
import { createGitService, createScanState, emptyGit, failedGit } from "./server/git";
import { buildStatus, releaseStatus } from "./server/dashboard";
import { createProcessRunner } from "./server/process";
import { normalizePath } from "./server/parse";
import { createProgressiveStatus } from "./server/progressive-status";

export default function contribute(server: PluginServerContext) {
  const scanRunner = createProcessRunner();
  const scanState = createScanState();
  const runners = new Set<ReturnType<typeof createProcessRunner>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let serverContext: (id: string) => Promise<import("@getpaseo/client").PaseoWorkspace | null> = async () => null;
  const service = createProgressiveStatus({
    async fast(workspaceId) {
      const workspace = await serverContext(workspaceId);
      const cwd = workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? "";
      const runner = createProcessRunner();
      runners.add(runner);
      try {
        const git = cwd ? await createGitService(runner, scanRunner, scanState).fastGitStatus(cwd)
          .catch(() => emptyGit(cwd, "error")) : emptyGit(cwd, "error");
        return { git, build: { status: "dashboard_down", loading: true, pipelines: [] }, release: { status: "dashboard_down", loading: true, products: [] } };
      } finally {
        await runner.cleanup();
        runners.delete(runner);
      }
    },
    snapshot(status) {
      const state = status.git.mainPath && scanState.scans.get(normalizePath(status.git.mainPath));
      if (!state) return status;
      return { ...status, git: {
        ...status.git, scanning: state.scanning, changesScannedAt: state.scannedAt, scanError: state.error,
        worktrees: status.git.worktrees.map((w) => w.current ? w : {
          ...w, changes: state.values.get(normalizePath(w.path)) ?? w.changes,
        }),
      } };
    },
    async complete(cwd, force) {
      const runner = createProcessRunner();
      runners.add(runner);
      const controller = new AbortController();
      controllers.add(controller);
      const gitService = createGitService(runner, scanRunner, scanState, () => !closed);
      try {
        const git = await gitService.gitStatus(cwd, force).catch((error: unknown) => failedGit(cwd, error));
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
        controller.abort();
        controllers.delete(controller);
        await runner.cleanup();
        runners.delete(runner);
      }
    },
  });
  server.handle(statusRpc, ({ workspaceId, force }, context) => {
    serverContext = (id) => context.paseo.workspaces.ref(id).refresh().catch(() => null);
    return service.get(workspaceId, force);
  });
  return async () => {
    closed = true;
    service.clear();
    scanState.closed = true;
    scanState.scans.clear();
    for (const controller of controllers) controller.abort();
    await Promise.all([scanRunner.cleanup(), ...[...runners].map((runner) => runner.cleanup())]);
  };
}
