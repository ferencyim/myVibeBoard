import { delimiter, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  buildTasksInstructions,
  TASKS_SKILL_MARKER,
} from "./shared/constants";
import {
  attachTaskThreadRpc,
  boardMoveRpc,
  createCommentRpc,
  createFolderRpc,
  createLabelRpc,
  createPresetRpc,
  createProjectRpc,
  createTaskRpc,
  delegateTaskRpc,
  deleteAttachmentRpc,
  deleteFolderRpc,
  deleteLabelRpc,
  deletePresetRpc,
  deleteProjectRpc,
  deleteTaskRpc,
  detachTaskThreadRpc,
  downloadAttachmentRpc,
  getAgentTasksRpc,
  getTaskByKeyRpc,
  getTaskRpc,
  listAttachmentsRpc,
  listCommentsRpc,
  listFoldersRpc,
  listLabelsRpc,
  listPaseoProjectsRpc,
  listPresetsRpc,
  listProjectsRpc,
  listProviderCatalogRpc,
  listTaskPullRequestsRpc,
  listTasksRpc,
  listTaskThreadsRpc,
  moveFolderRpc,
  moveTaskToProjectRpc,
  renameFolderRpc,
  renameProjectPrefixRpc,
  searchTaskAttachmentsRpc,
  searchThreadsRpc,
  seedDemoRpc,
  sidebarOpenTaskCountRpc,
  sidebarSummaryRpc,
  updateLabelRpc,
  updatePresetRpc,
  updateProjectRpc,
  updateTaskRpc,
  uploadAttachmentRpc,
} from "./shared/contract";
import { tasksSettings } from "./shared/settings";
import { startTasksBridge, type TasksBridgeHandle } from "./server/bridge";
import {
  createApiStore,
  createDomainHandlers,
  registerLifecycleHooks,
  seedDemoData,
} from "./server/domain";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(tasksSettings);
  const store = createApiStore();
  store.ensureDefaultPresets();

  let latestPaseo: PaseoApi | null = null;
  const capturePaseo = (paseo: PaseoApi) => {
    latestPaseo = paseo;
  };

  const domain = createDomainHandlers(store, () => latestPaseo);

  let bridge: TasksBridgeHandle | null = null;
  const bridgeReady = startTasksBridge(store, domain)
    .then((handle) => {
      bridge = handle;
      return handle;
    })
    .catch((error) => {
      console.error("Failed to start Tasks local bridge:", error);
      return null;
    });

  server.before("agent.create", async ({ request }, { paseo }) => {
    capturePaseo(paseo);
    const currentSettings = await settings.read();
    const values =
      currentSettings.status === "ready"
        ? currentSettings.values
        : {
            autoInjectCliAndMcp: true,
            autoInjectInstructions: true,
            defaultView: "board" as const,
            showCompletedInBoard: true,
          };

    const activeBridge = bridge ?? (await bridgeReady);
    let nextConfig = { ...request.config };

    if (values.autoInjectInstructions) {
      const existingPrompt = nextConfig.systemPrompt ?? "";
      if (!existingPrompt.includes(TASKS_SKILL_MARKER)) {
        nextConfig.systemPrompt = [existingPrompt, buildTasksInstructions()]
          .filter(Boolean)
          .join("\n\n");
      }
    }

    if (values.autoInjectCliAndMcp && activeBridge) {
      nextConfig.mcpServers = {
        ...nextConfig.mcpServers,
        tasks: {
          type: "stdio",
          command: process.execPath,
          args: [activeBridge.mcpScriptPath],
          env: {
            PASEO_TASKS_BRIDGE_FILE: join(store.dataDir, "bridge.json"),
          },
        },
      };
    }

    return {
      ...request,
      config: nextConfig,
    };
  });

  server.before("agent.session_open", async ({ request }, { paseo }) => {
    capturePaseo(paseo);
    const currentSettings = await settings.read();
    const autoInject =
      currentSettings.status === "ready"
        ? currentSettings.values.autoInjectCliAndMcp
        : true;
    if (!autoInject) return;

    const activeBridge = bridge ?? (await bridgeReady);
    const binDir = activeBridge?.binDir ?? join(store.dataDir, "bin");
    const inheritedPath = request.env.PATH ?? process.env.PATH ?? "";
    const pathParts = inheritedPath.split(delimiter).filter(Boolean);
    const nextPath = pathParts.includes(binDir)
      ? inheritedPath
      : [binDir, ...pathParts].join(delimiter);

    const linkedTasks = store.tasks.listTaskThreadsByThreadId(request.agentId);
    const primaryTask = linkedTasks[0]
      ? store.tasks.getTask(linkedTasks[0].taskId)
      : undefined;

    return {
      ...request,
      env: {
        ...request.env,
        PATH: nextPath,
        PASEO_TASKS_BRIDGE_FILE: join(store.dataDir, "bridge.json"),
        BB_THREAD_ID: request.agentId,
        ...(primaryTask
          ? {
              PASEO_TASK_KEY: primaryTask.key,
              PASEO_TASK_ID: primaryTask.id,
              BB_TASK_KEY: primaryTask.key,
            }
          : {}),
      },
    };
  });

  registerLifecycleHooks(server, store, capturePaseo);

  // Folder handlers
  server.handle(createFolderRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.createFolder(input);
  });
  server.handle(renameFolderRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.renameFolder(input);
  });
  server.handle(moveFolderRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.moveFolder(input);
  });
  server.handle(deleteFolderRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.deleteFolder(input);
  });
  server.handle(listFoldersRpc, (_input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listFolders();
  });

  // Project handlers
  server.handle(createProjectRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.createProject(input);
  });
  server.handle(updateProjectRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.updateProject(input);
  });
  server.handle(renameProjectPrefixRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.renameProjectPrefix(input);
  });
  server.handle(deleteProjectRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.deleteProject(input);
  });
  server.handle(listProjectsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listProjects(input);
  });
  server.handle(listPaseoProjectsRpc, (_input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listPaseoProjects(paseo);
  });
  server.handle(sidebarOpenTaskCountRpc, (_input, { paseo }) => {
    capturePaseo(paseo);
    return domain.sidebarOpenTaskCount();
  });
  server.handle(sidebarSummaryRpc, (_input, { paseo }) => {
    capturePaseo(paseo);
    return domain.sidebarSummary();
  });

  // Task handlers
  server.handle(createTaskRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.createTask(input);
  });
  server.handle(getTaskRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.getTask(input);
  });
  server.handle(getTaskByKeyRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.getTaskByKey(input);
  });
  server.handle(updateTaskRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.updateTask(input);
  });
  server.handle(deleteTaskRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.deleteTask(input);
  });
  server.handle(listTasksRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listTasks(input);
  });
  server.handle(boardMoveRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.boardMove(input);
  });
  server.handle(moveTaskToProjectRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.moveTaskToProject(input);
  });

  // Label handlers
  server.handle(createLabelRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.createLabel(input);
  });
  server.handle(updateLabelRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.updateLabel(input);
  });
  server.handle(deleteLabelRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.deleteLabel(input);
  });
  server.handle(listLabelsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listLabels(input);
  });

  // Comment handlers
  server.handle(createCommentRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.createComment(input, paseo);
  });
  server.handle(listCommentsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listComments(input, paseo);
  });

  // Attachment handlers
  server.handle(listAttachmentsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listAttachments(input);
  });
  server.handle(uploadAttachmentRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.uploadAttachment(input);
  });
  server.handle(downloadAttachmentRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.downloadAttachment(input);
  });
  server.handle(deleteAttachmentRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.deleteAttachment(input);
  });

  // Thread & Delegation handlers
  server.handle(listTaskThreadsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listTaskThreads(input);
  });
  server.handle(listTaskPullRequestsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listTaskPullRequests(input, paseo);
  });
  server.handle(delegateTaskRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.delegate(input, paseo);
  });
  server.handle(attachTaskThreadRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.taskThreadsAttach(input, paseo);
  });
  server.handle(detachTaskThreadRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.taskThreadsDetach(input);
  });
  server.handle(getAgentTasksRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.getAgentTasks(input);
  });
  server.handle(searchThreadsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.searchThreads(input, paseo);
  });

  // Preset & Provider Catalog handlers
  server.handle(createPresetRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.createPreset(input);
  });
  server.handle(updatePresetRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.updatePreset(input);
  });
  server.handle(deletePresetRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.deletePreset(input);
  });
  server.handle(listPresetsRpc, (_input, { paseo }) => {
    capturePaseo(paseo);
    store.ensureDefaultPresets();
    return domain.listPresets();
  });
  server.handle(listProviderCatalogRpc, (_input, { paseo }) => {
    capturePaseo(paseo);
    return domain.listProviderCatalog(paseo);
  });

  // Demo seed & Composer attachment search
  server.handle(seedDemoRpc, async (input, { paseo }) => {
    capturePaseo(paseo);
    let linkedProjectId = input.linkedProjectId;
    if (!linkedProjectId) {
      const projects = await domain.listPaseoProjects(paseo);
      linkedProjectId = projects.bbProjects[0]?.id;
    }
    return seedDemoData(store, domain, linkedProjectId);
  });
  server.handle(searchTaskAttachmentsRpc, (input, { paseo }) => {
    capturePaseo(paseo);
    return domain.searchAttachmentItems(input);
  });

  return async () => {
    const activeBridge = bridge ?? (await bridgeReady);
    await activeBridge?.close();
    store.db.close();
  };
}
