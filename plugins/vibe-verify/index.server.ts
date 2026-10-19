import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createNodeRunner } from "./server/collectors/common";
import { isEvent } from "./server/vibe/contract";
import { createPipeline } from "./server/pipeline";
import { createVerifyRegistry, type RunConfigs } from "./server/registry";
import { registerVerifyRpcs } from "./server/rpc";
import { createVerifyStore } from "./server/store";
import { createPaseoVerifierLauncher, type VerifierLauncher } from "./server/verifier/agent";
import { decideVerifierPermission } from "./server/verifier/policy";
import {
  createEventConsumer,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  resolveVibeHome,
} from "./server/vibe/db";

export default function contribute(server: PluginServerContext) {
  const db = openVibeDb();
  migrateOwner(db, "verify");
  const board = createVibeStore(db);
  const home = resolveVibeHome();
  const verify = createVerifyStore(db, { root: join(home, "verify") });
  const configs: RunConfigs = new Map();
  const log = (message: string, error?: unknown) =>
    console.error(`[vibe-verify] ${message}`, error ?? "");

  let paseo: PaseoApi | null = null;
  const remember = (api: PaseoApi) => void (paseo = api);
  for (const name of ["agent.created", "agent.turn_started", "agent.turn_ended"] as const) {
    server.on(name, (_event, { paseo: api }) => remember(api));
  }

  // Verifier agents -> where they may write (their output directory); read-only otherwise.
  const verifierDirs = new Map<string, string>();
  const inner = createPaseoVerifierLauncher({ getPaseo: () => paseo });
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
    registry: createVerifyRegistry({ configs }),
    runner: createNodeRunner(),
    launcher,
    configs,
    notifyWorker: async (agentId, prompt) => {
      if (!paseo) return false;
      await paseo.agents.ref(agentId).send(prompt);
      return true;
    },
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
    types: ["card.moved"],
    startAt: "now",
    handler: (event) => {
      if (isEvent(event, "card.moved") && event.payload.to === "verifying" && event.cardId) {
        start(event.cardId);
      }
    },
    onError: (error) => log("event handling failed", error),
  });
  consumer.start();

  registerVerifyRpcs(server, { board, verify, pipeline, rerun: start });

  return async () => {
    await consumer.stop();
    db.close();
  };
}
