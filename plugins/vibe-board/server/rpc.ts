import { getProjectDefaults, setProjectDefaults } from "./project-defaults";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/rpc";
import type { BoardService } from "./service";
import { createRequirementsService } from "./requirements";
import { resolveMainConfig } from "./main-model";
import { providerCatalog } from "./provider-catalog";
async function listPaseoProjects(paseo: PaseoApi) {
  try {
    const result = await paseo.projects.list();
    return {
      projects: result.projects.map((project) => ({
        id: project.projectId,
        name:
          project.projectCustomName?.trim() ||
          project.projectDisplayName ||
          project.projectRootPath,
        rootPath: project.projectRootPath,
        kind: project.projectKind,
      })),
    };
  } catch {
    return { projects: [] };
  }
}

export function registerBoardRpcs(server: PluginServerContext, board: BoardService) {
  server.handle(rpc.projectsListRpc, (input) => board.projects.list(input.includeArchived));
  server.handle(rpc.projectsCreateRpc, (input) => board.projects.create(input));
  server.handle(rpc.projectsUpdateRpc, ({ project, ...patch }) =>
    board.projects.update(project, patch),
  );
  server.handle(rpc.paseoProjectsListRpc, (_input, { paseo }) => listPaseoProjects(paseo));
  server.handle(rpc.resolveMainConfigRpc, async ({ projectId }, { paseo }) => {
    const { projects } = await paseo.projects.list();
    const project = projects.find((candidate) => candidate.projectId === projectId);
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
    const { projects } = await paseo.projects.list();
    const project = projects.find((p) => p.projectId === projectId);
    if (!project) throw new Error("项目不存在");
    return getProjectDefaults(board, projectId, project.projectRootPath);
  });
  server.handle(rpc.projectDefaultsSetRpc, async (input, { paseo }) => {
    const { projects } = await paseo.projects.list();
    const project = projects.find((p) => p.projectId === input.projectId);
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
