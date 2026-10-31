import { listHostProjects } from "./host-data";
import { getProjectDefaults, setProjectDefaults } from "./project-defaults";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/rpc";
import type { BoardService } from "./service";
import { createRequirementsService } from "./requirements";
import { resolveMainConfig } from "./main-model";
import { providerCatalog } from "./provider-catalog";
export function registerBoardRpcs(
  server: PluginServerContext,
  board: BoardService,
  getPaseo?: () => PaseoApi | null,
) {
  const hostProject = async (api: PaseoApi, id: string) => {
    const host = getPaseo?.() ?? api;
    const current = await listHostProjects(host);
    return current.projects.find((p) => p.projectId === id) ??
      (await listHostProjects(host, true)).projects.find((p) => p.projectId === id);
  };
  server.handle(rpc.resolveMainConfigRpc, async ({ projectId }, { paseo }) => {
    const project = await hostProject(paseo, projectId);
    if (!project) throw new Error("项目不存在");
    return resolveMainConfig(board.store, projectId, project.projectRootPath);
  });
  server.handle(rpc.presetsListRpc, () => board.presets.list());
  server.handle(rpc.presetsCreateRpc, (input) => board.presets.create(input));
  server.handle(rpc.presetsUpdateRpc, ({ presetId, ...patch }) =>
    board.presets.update(presetId, patch),
  );
  server.handle(rpc.presetsDeleteRpc, (input) => board.presets.delete(input.presetId));
  server.handle(rpc.providersCatalogRpc, (_input, { paseo }) => providerCatalog(paseo));
  server.handle(rpc.projectDefaultsGetRpc, async ({ projectId }, { paseo }) => {
    const project = await hostProject(paseo, projectId);
    if (!project) throw new Error("项目不存在");
    return getProjectDefaults(board, projectId, project.projectRootPath);
  });
  server.handle(rpc.projectDefaultsSetRpc, async (input, { paseo }) => {
    const project = await hostProject(paseo, input.projectId);
    if (!project) throw new Error("项目不存在");
    return setProjectDefaults(board, {
      ...input,
      name: project.projectCustomName?.trim() || project.projectDisplayName || project.projectId,
      rootPath: project.projectRootPath,
    });
  });
  server.handle(rpc.defaultsGetRpc, () => board.defaults.get());
  server.handle(rpc.defaultsSetRpc, (input) => board.defaults.set(input.global));
  server.handle(rpc.promptsListRpc, (input) => board.prompts.list(input.projectId));
  server.handle(rpc.promptsSetRpc, (input) =>
    board.prompts.set(input.key, input.text, input.projectId),
  );
  server.handle(rpc.promptsClearRpc, (input) => board.prompts.clear(input.key, input.projectId));
  const requirements = createRequirementsService({ board });
  server.handle(rpc.requirementsGetRpc, (input) => requirements.get(input.project));
  server.handle(rpc.requirementsSaveRpc, (input) =>
    requirements.save(input.project, input.content),
  );
}
