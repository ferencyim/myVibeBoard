import { delimiter, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { boardSettings } from "./shared/settings";
import { resolveVibeHome } from "./server/vibe/db";
import { startBoardBridge, type BoardBridgeHandle } from "./server/mcp/bridge";
import { BOARD_INSTRUCTIONS_MARKER, buildBoardInstructions } from "./server/mcp/instructions";
import { createDispatcher } from "./server/dispatch";
import { startAdmissionConsumer } from "./server/dispatch/admission";
import { registerLifecycle } from "./server/lifecycle";
import { startFinalizer } from "./server/lifecycle/finalize";
import { createGitFinalizer } from "./server/lifecycle/git-finalize";
import { registerBoardRpcs } from "./server/rpc";
import { createBoardService, openBoardRuntime } from "./server/service";
import { createReplyService, createSyncService } from "./server/sync";
import { createVerifyService } from "./server/verify";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(boardSettings);
  const runtime = openBoardRuntime();
  const board = createBoardService(runtime);
  const dataDir = join(resolveVibeHome(), "board");

  let bridge: BoardBridgeHandle | null = null;
  const bridgeReady = startBoardBridge(board, dataDir)
    .then((handle) => (bridge = handle))
    .catch((error) => {
      console.error("Failed to start the vibe-board local bridge:", error);
      return null;
    });

  async function autoInject(): Promise<{ cliAndMcp: boolean; instructions: boolean }> {
    const current = await settings.read();
    return current.status === "ready"
      ? {
          cliAndMcp: current.values.autoInjectCliAndMcp,
          instructions: current.values.autoInjectInstructions,
        }
      : { cliAndMcp: true, instructions: true };
  }

  server.before("agent.create", async ({ request }) => {
    const inject = await autoInject();
    const active = bridge ?? (await bridgeReady);
    const config = { ...request.config };

    if (inject.instructions && !(config.systemPrompt ?? "").includes(BOARD_INSTRUCTIONS_MARKER)) {
      config.systemPrompt = [config.systemPrompt ?? "", buildBoardInstructions()]
        .filter(Boolean)
        .join("\n\n");
    }
    if (inject.cliAndMcp && active) {
      config.mcpServers = {
        ...config.mcpServers,
        "vibe-board": {
          type: "stdio",
          command: process.execPath,
          args: [active.mcpScriptPath],
          env: { VIBE_BOARD_BRIDGE_FILE: active.bridgeFile },
        },
      };
    }
    return { ...request, config };
  });

  server.before("agent.session_open", async ({ request }) => {
    if (!(await autoInject()).cliAndMcp) return;
    const active = bridge ?? (await bridgeReady);
    if (!active) return;
    const inherited = request.env.PATH ?? process.env.PATH ?? "";
    const parts = inherited.split(delimiter).filter(Boolean);
    return {
      ...request,
      env: {
        ...request.env,
        PATH: parts.includes(active.binDir) ? inherited : [active.binDir, ...parts].join(delimiter),
        VIBE_BOARD_BRIDGE_FILE: active.bridgeFile,
      },
    };
  });

  // The SDK handle only reaches plugins through hook/RPC contexts; keep the newest one for dispatch.
  let paseo: PaseoApi | null = null;
  const onPaseo = (api: PaseoApi) => void (paseo = api);
  const lifecycle = registerLifecycle(server, { board, onPaseo });
  const dispatcher = createDispatcher({ board, getPaseo: () => paseo, tracker: lifecycle });
  const admission = startAdmissionConsumer({ db: runtime.db, board, dispatcher, onError: (e) => console.error("vibe-board admission:", e) });
  const sync = createSyncService({ db: runtime.db, store: runtime.store });
  const replies = createReplyService({ db: runtime.db, store: runtime.store, getPaseo: () => paseo });
  const finalizer = startFinalizer({
    db: runtime.db,
    board,
    finalize: createGitFinalizer({
      board,
      getConfig: async () => {
        const current = await settings.read();
        return current.status === "ready"
          ? {
              mode: current.values.finalizeMode,
              targetBranch: current.values.finalizeTargetBranch || undefined,
            }
          : { mode: "merge" };
      },
    }),
  });
  // Any RPC (e.g. the UI polling) refreshes the SDK handle, so scheduler-admitted dispatches work
  // without a prior agent event.
  const tracked = Object.create(server) as typeof server;
  tracked.handle = (contract, handler) =>
    server.handle(contract, (input, context) => {
      onPaseo(context.paseo);
      return handler(input, context);
    });
  registerBoardRpcs(tracked, board, {
    dispatcher,
    lifecycle,
    onPaseo,
    sync,
    replies,
    verify: createVerifyService({ db: runtime.db, board }),
  });

  return async () => {
    await admission.stop();
    lifecycle.close();
    await finalizer.stop();
    await (bridge ?? (await bridgeReady))?.close();
    runtime.close();
  };
}
