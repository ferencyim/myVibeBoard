import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createNodeRunner } from "./server/collectors/common";
import { verifySettings } from "./shared/settings";
import { createVerifyPrompts } from "./server/prompts";
import { tuningOf, type VerifyTuning } from "./server/tuning";
import { isEvent } from "./server/vibe/contract";
import { createPipeline } from "./server/pipeline";
import { createVerifyRegistry, type RunConfigs } from "./server/registry";
import { registerVerifyRpcs } from "./server/rpc";
import { createVerifyStore } from "./server/store";
import { createPaseoVerifierLauncher, type VerifierLauncher } from "./server/verifier/agent";
import { decideVerifierPermission } from "./server/verifier/policy";
import {
  createDeviceLeases,
  createEventConsumer,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  resolveVibeHome,
} from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "scheduler");
  migrateOwner(db, "verify");
  const board = createVibeStore(db);
  const home = resolveVibeHome();
  const prompts = createVerifyPrompts(board);
  prompts.register();
  const verify = createVerifyStore(db, { root: join(home, "verify") });
  const configs: RunConfigs = new Map();
  const log = (message: string, error?: unknown) =>
    console.error(`[vibe-verify] ${message}`, error ?? "");

  // Owner settings, read on every use; the env vars are the initial values while a setting is unset.
  const settings = server.registerSettings(verifySettings);
  let tuning: VerifyTuning = tuningOf(verifySettings.schema.parse({}));
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") tuning = tuningOf(state.values);
  };
  void settings.read().then(applySettings);
  const stopSettings = settings.subscribe(applySettings);
  const getTuning = () => tuning;

  let paseo: PaseoApi | null = null;
  const remember = (api: PaseoApi) => void (paseo = api);
  for (const name of ["agent.created", "agent.turn_started", "agent.turn_ended"] as const) {
    server.on(name, (_event, { paseo: api }) => remember(api));
  }

  // Verifier agents -> where they may write (their output directory); read-only otherwise.
  const verifierDirs = new Map<string, string>();
  const inner = createPaseoVerifierLauncher({
    getPaseo: () => paseo,
    prompts,
    roundTimeoutMs: () => tuning.roundTimeoutMs,
  });
  const launcher: VerifierLauncher = {
    async launch(input) {
      const agent = await inner.launch(input);
      verifierDirs.set(agent.agentId, input.outputDir);
      return {
        ...agent,
        run: agent.run.bind(agent),
        close: async () => {
          await agent.close();
          verifierDirs.delete(agent.agentId);
        },
      };
    },
  };
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    remember(api);
    const outputDir = verifierDirs.get(agent.id);
    if (!outputDir) return;
    const response = decideVerifierPermission(request, { outputDir });
    await api.agents
      .ref(agent.id)
      .respondToPermission({ requestId: request.id, response })
      .catch((error) => log("answering a verifier permission request failed", error));
  });

  const pipeline = createPipeline({
    board,
    verify,
    registry: createVerifyRegistry({
      configs,
      leases: createDeviceLeases(db).provider,
      readyTimeoutMs: () => tuning.readyTimeoutMs,
    }),
    runner: createNodeRunner(),
    launcher,
    configs,
    notifyWorker: async (agentId, prompt) => {
      if (!paseo) return false;
      await paseo.agents.ref(agentId).send(prompt);
      return true;
    },
    tuning: getTuning,
    prompts,
    worktreeRoot: process.env.VIBE_WORKTREE_ROOT?.trim() || join(home, "worktrees"),
    log,
  });

  const start = (cardId: string) => {
    pipeline.run(cardId).catch((error) => log(`verification of ${cardId} crashed`, error));
  };

  // Verifications interrupted by a restart: close them as doubtful and run again.
  for (const stale of verify.running()) {
    verify.writeNotes(stale.id, ["Interrupted by a daemon restart"]);
    verify.finish(stale.id, "doubt", null);
    if (board.cards.get(stale.cardId)?.column === "verifying") start(stale.cardId);
  }

  const consumer = createEventConsumer({
    db,
    consumer: "vibe-verify",
    types: ["card.moved", "verification.decision_requested"],
    startAt: "now",
    handler: async (event) => {
      if (isEvent(event, "card.moved") && event.payload.to === "verifying" && event.cardId) {
        start(event.cardId);
      }
      // Requests from the board UI (it cannot call this plugin's RPCs): only while still verifying.
      if (isEvent(event, "verification.decision_requested") && event.cardId) {
        if (board.cards.get(event.cardId)?.column !== "verifying") return;
        const { action, comment } = event.payload;
        if (action === "reject" && comment?.trim()) await pipeline.reject(event.cardId, comment.trim());
        else if (action === "rerun" && !pipeline.isRunning(event.cardId)) start(event.cardId);
      }
    },
    onError: (error) => log("event handling failed", error),
  });
  consumer.start();

  registerVerifyRpcs(server, { board, verify, pipeline, rerun: start });

  return async () => {
    stopSettings();
    await consumer.stop();
    db.close();
  };
}
