import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createBoardService, openBoardRuntime } from "./server/service";
import { registerBoardRpcs } from "./server/rpc";
import { verifyEvidenceRpc } from "./shared/evidence";
import { createTaskEvidenceReader } from "./server/evidence";
import { registerTaskRuntime } from "./server/task-runtime";

export default function contribute(server: PluginServerContext) {
  const runtime = openBoardRuntime();
  let paseo: PaseoApi | null = (server as { paseo?: PaseoApi }).paseo ?? null;
  const tasks = registerTaskRuntime(server, {
    db: runtime.db,
    store: runtime.store,
    getPaseo: () => paseo,
    onPaseo: (api) => {
      paseo = api;
    },
  });
  registerBoardRpcs(server, createBoardService(runtime));
  const evidence = createTaskEvidenceReader(runtime.db);
  server.handle(verifyEvidenceRpc, (input) => evidence.evidence(input.evidenceId, input.thumb));
  return async () => {
    await tasks.close();
    runtime.close();
  };
}
