import { delimiter, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { boardSettings } from "./shared/settings";
import { publishEvent, resolveVibeHome } from "./server/vibe/db";
import { startBoardBridge, type BoardBridgeHandle } from "./server/mcp/bridge";
import { injectBoard } from "./server/mcp/inject";
import { createDispatcher } from "./server/dispatch";
import { convertNative } from "./server/dispatch/convert";
import { createReassigner } from "./server/dispatch/reassign";
import { startAdmissionConsumer } from "./server/dispatch/admission";
import { registerLifecycle } from "./server/lifecycle";
import { startFinalizer } from "./server/lifecycle/finalize";
import { createWatchdog, DEFAULT_STALL_CONFIG, parseProviderMinutes } from "./server/lifecycle/watchdog";
import { createGitFinalizer } from "./server/lifecycle/git-finalize";
import { registerBoardRpcs } from "./server/rpc";
import { createBoardService, openBoardRuntime } from "./server/service";
import { createReplyService, createSyncService } from "./server/sync";
import { createRequirementsService } from "./server/requirements";
import { createScoutService } from "./server/scout";
import { createVerifyService } from "./server/verify";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(boardSettings);
  const runtime = openBoardRuntime();
  const board = createBoardService(runtime);
  const dataDir = join(resolveVibeHome(), "board");

  // The SDK handle arrives later through hooks/RPCs (see below); scouts read it lazily.
  let paseo: PaseoApi | null = (server as { paseo?: PaseoApi }).paseo ?? null;
  const scout = createScoutService({
    board,
    getPaseo: () => paseo,
    getConfig: async () => {
      const current = await settings.read();
      const values = current.status === "ready" ? current.values : null;
      return {
        preset: values?.scoutPreset ?? "",
        maxParallel: values?.scoutMaxParallel ?? 4,
        timeoutMs: (values?.scoutTimeoutSec ?? 300) * 1000,
      };
    },
    publish: (type, cardId, projectId, payload) =>
      void publishEvent(runtime.db, { type, cardId, projectId, payload } as never),
  });

  let bridge: BoardBridgeHandle | null = null;
  const bridgeReady = startBoardBridge(board, dataDir, scout)
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
    return injectBoard(request, inject, active, process.execPath);
  });

  server.before("agent.session_open", async ({ request }) => {
    if (request.env?.VIBE_ROLE === "scout" || !(await autoInject()).cliAndMcp) return;
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

  // Hosts that expose the handle at start-up (server.paseo) let dispatch run with no UI attached;
  // older hosts only hand it over through hook/RPC contexts, which keep refreshing it below.
  const onPaseo = (api: PaseoApi) => void (paseo = api);
  const failoverEnabled = async () => {
    const current = await settings.read();
    return current.status !== "ready" || current.values.failoverEnabled;
  };
  // The reassigner needs the lifecycle (tracker) and the lifecycle needs the reassigner (onFailure):
  // the callback resolves it lazily.
  let reassigner: ReturnType<typeof createReassigner> | null = null;
  const lifecycle = registerLifecycle(server, {
    board,
    onPaseo,
    onFailure: async (session, failure) => {
      if (!reassigner || !(await failoverEnabled())) return false;
      const result = await reassigner.reassign(session.id, failure);
      if (!result.reassigned && session.cardId) {
        board.store.events.add({
          cardId: session.cardId,
          type: "status",
          authorKind: "system",
          author: "failover",
          body: {
            kind: "failover_failed",
            category: failure.category,
            text: `No agent could take over (${result.reason}${result.attempts.length ? `: ${result.attempts.join("; ")}` : ""}).`,
          },
        });
      }
      return result.reassigned !== null;
    },
  });
  reassigner = createReassigner({
    board,
    getPaseo: () => paseo,
    tracker: lifecycle,
    convert: convertNative,
    guardImport: (workspaceId, fn) => lifecycle.withoutSwitchRecord(workspaceId, fn),
    log: (m, e) => console.error(`[vibe-board failover] ${m}`, e ?? ""),
  });
  const dispatcher = createDispatcher({
    board,
    getPaseo: () => paseo,
    tracker: lifecycle,
    failoverEnabled,
  });
  const watchdog = createWatchdog({
    board,
    getPaseo: () => paseo,
    getConfig: async () => {
      const current = await settings.read();
      if (current.status !== "ready") return DEFAULT_STALL_CONFIG;
      return {
        enabled: current.values.stallDetection,
        minutes: current.values.stallMinutes,
        providerMinutes: parseProviderMinutes(current.values.stallProviderMinutes),
        autoInterruptMinutes: current.values.stallAutoInterruptMinutes,
      };
    },
  });
  watchdog.start();
  const admission = startAdmissionConsumer({ db: runtime.db, board, dispatcher, onError: (e) => console.error("vibe-board admission:", e) });
  const sync = createSyncService({ db: runtime.db, store: runtime.store });
  const replies = createReplyService({ db: runtime.db, store: runtime.store, getPaseo: () => paseo });
  const finalizer = startFinalizer({
    db: runtime.db,
    board,
    finalize: createGitFinalizer({
      board,
      getPaseo: () => paseo,
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
    requirements: createRequirementsService({ board, db: runtime.db }),
    verify: createVerifyService({ db: runtime.db, board }),
  });

  return async () => {
    watchdog.stop();
    await admission.stop();
    lifecycle.close();
    await finalizer.stop();
    await (bridge ?? (await bridgeReady))?.close();
    runtime.close();
  };
}
