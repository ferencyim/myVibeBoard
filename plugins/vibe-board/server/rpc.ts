// Registers every shared/rpc contract on the plugin server, backed by the board service.

import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import * as rpc from "../shared/rpc";
import type { ChatService } from "./chat";
import type { FlowService } from "./flow";
import type { Dispatcher } from "./dispatch";
import { linkPaseoProject } from "./dispatch/link-project";
import type { RequirementsService } from "./requirements";
import type { Lifecycle } from "./lifecycle";
import type { ReplyService, SyncService } from "./sync";
import type { BoardService } from "./service";
import type { VerifyService } from "./verify";

async function listPaseoProjects(paseo: PaseoApi) {
  try {
    const result = await paseo.projects.list();
    return {
      projects: result.projects.map((project) => ({
        id: project.projectId,
        name:
          project.projectCustomName?.trim() || project.projectDisplayName || project.projectRootPath,
        rootPath: project.projectRootPath,
        kind: project.projectKind,
      })),
    };
  } catch {
    return { projects: [] };
  }
}

async function providerCatalog(paseo: PaseoApi) {
  try {
    const available = await paseo.providers.listAvailable();
    const providers = await Promise.all(
      available.providers.map(async (p) => {
        let models: Array<{
          id: string;
          name: string;
          thinkingOptions?: Array<{ id: string; label: string }>;
          defaultThinkingOptionId?: string;
        }> = [];
        if (p.available) {
          try {
            const res = await paseo.providers.listModels(p.provider);
            models = (res.models ?? []).map((m) => ({
              id: m.id,
              name: m.label || m.id,
              thinkingOptions: m.thinkingOptions?.map((o) => ({ id: o.id, label: o.label || o.id })),
              defaultThinkingOptionId:
                m.defaultThinkingOptionId ?? m.thinkingOptions?.find((o) => o.isDefault)?.id,
            }));
          } catch {
            // model listing is best effort
          }
        }
        return { id: p.provider, available: p.available, models };
      }),
    );
    return { providers };
  } catch {
    return { providers: [] };
  }
}

export interface BoardRpcExtras {
  dispatcher?: Dispatcher;
  lifecycle?: Lifecycle;
  sync?: SyncService;
  replies?: ReplyService;
  /** Project requirements document. */
  requirements?: RequirementsService;
  /** 制定方案 / 立即执行 / executing model switch (WP-105). */
  flow?: FlowService;
  /** Verification result for the card UI (WP-21). */
  verify?: VerifyService;
  /** Group chat: owner messages and accept / reject of the master's proposals (WP-92). */
  chat?: ChatService;
  /** Keeps the newest SDK handle for dispatch outside hooks. */
  onPaseo?: (paseo: PaseoApi) => void;
}

export function registerBoardRpcs(
  server: PluginServerContext,
  board: BoardService,
  extras: BoardRpcExtras = {},
): void {
  server.handle(rpc.projectsListRpc, (input) => board.projects.list(input.includeArchived));
  server.handle(rpc.projectsCreateRpc, async (input, { paseo }) => {
    const created = board.projects.create(input);
    // Best effort: a failure leaves it unlinked and dispatch retries with a precise message.
    await linkPaseoProject(board, paseo, created.project).catch(() => undefined);
    return { project: board.projects.resolve(created.project.id) };
  });
  server.handle(rpc.projectsUpdateRpc, async ({ project, ...patch }, { paseo }) => {
    const before = board.projects.resolve(project);
    const updated = board.projects.update(project, patch);
    // A changed repository path makes the old link stale unless the caller set a new one.
    if (patch.repoPath !== undefined && patch.paseoProjectId === undefined && patch.repoPath !== before.repoPath) {
      await linkPaseoProject(board, paseo, { ...updated.project, paseoProjectId: null }).catch(() => undefined);
      return { project: board.projects.resolve(project) };
    }
    return updated;
  });
  server.handle(rpc.paseoProjectsListRpc, (_input, { paseo }) => listPaseoProjects(paseo));

  server.handle(rpc.boardSummaryRpc, () => board.cards.summary());
  server.handle(rpc.cardsListRpc, (input) => board.cards.list(input));
  server.handle(rpc.cardsGetRpc, (input) => board.cards.detail(input.card));
  server.handle(rpc.cardsCreateRpc, (input) => board.cards.create(input));
  server.handle(rpc.cardsUpdateRpc, ({ card, ...patch }) => board.cards.update(card, patch));
  server.handle(rpc.cardsMoveRpc, ({ card, ...input }) => board.cards.move(card, input));
  server.handle(rpc.cardsReorderRpc, ({ card, ...input }) => board.cards.reorder(card, input));
  server.handle(rpc.cardsArchiveRpc, (input) => board.archive(input.card, input.archived));
  server.handle(rpc.cardsDeleteRpc, (input) => board.remove(input.card));

  server.handle(rpc.eventsListRpc, (input) => board.events.list(input.card));
  server.handle(rpc.eventsAddRpc, ({ card, ...input }) => board.events.add(card, input));
  server.handle(rpc.plansListRpc, (input) => board.plans.list(input.card));
  server.handle(rpc.plansSaveRpc, (input) => board.plans.save(input.card, input.snapshot));

  server.handle(rpc.tagsListRpc, () => board.tags.list());
  server.handle(rpc.tagsCreateRpc, (input) => board.tags.create(input.name, input.evidence, input.color));
  server.handle(rpc.tagsUpdateRpc, ({ tagId, ...patch }) => board.tags.update(tagId, patch));
  server.handle(rpc.tagsDeleteRpc, (input) => board.tags.delete(input.tagId));
  server.handle(rpc.presetsListRpc, () => board.presets.list());
  server.handle(rpc.presetsCreateRpc, (input) => board.presets.create(input));
  server.handle(rpc.presetsUpdateRpc, ({ presetId, ...patch }) => board.presets.update(presetId, patch));
  server.handle(rpc.presetsDeleteRpc, (input) => board.presets.delete(input.presetId));
  server.handle(rpc.providersCatalogRpc, (_input, { paseo }) => providerCatalog(paseo));

  server.handle(rpc.promptsListRpc, (input) => board.prompts.list(input.projectId));
  server.handle(rpc.promptsSetRpc, (input) => board.prompts.set(input.key, input.text, input.projectId));
  server.handle(rpc.promptsClearRpc, (input) => board.prompts.clear(input.key, input.projectId));

  server.handle(rpc.attachmentsListRpc, (input) => board.attachments.list(input.card));
  server.handle(rpc.attachmentsUploadRpc, ({ card, base64, ...input }) =>
    board.attachments.upload(card, { ...input, bytes: Buffer.from(base64, "base64") }),
  );
  server.handle(rpc.attachmentsDownloadRpc, (input) => {
    const { attachment, content } = board.attachments.read(input.attachmentId);
    return { attachment, base64: content.toString("base64") };
  });
  server.handle(rpc.attachmentsDeleteRpc, (input) => board.attachments.delete(input.attachmentId));
  server.handle(rpc.sessionsListRpc, (input) => board.sessions.list(input.card));

  const { dispatcher, lifecycle, sync, replies, verify, requirements, chat, flow } = extras;
  if (chat) {
    server.handle(rpc.chatSendRpc, (input) =>
      chat.send(input.card, input.text, input.actor, input.thread, input.subtask),
    );
    server.handle(rpc.proposalsAcceptRpc, (input) => chat.accept(input.eventId, input.actor));
    server.handle(rpc.proposalsRejectRpc, (input) => chat.reject(input.eventId, input.actor));
  }
  if (requirements) {
    server.handle(rpc.requirementsGetRpc, (input) => requirements.get(input.project));
    server.handle(rpc.requirementsSaveRpc, (input) => requirements.save(input.project, input.content));
  }
  if (flow) {
    server.handle(rpc.planStartRpc, (input) => flow.planStart(input.card, input.actor));
    server.handle(rpc.planSubtasksRpc, (input) => flow.setSubtasks(input.card, input.subtasks, input.actor));
    server.handle(rpc.execStartRpc, async (input, { paseo }) => {
      extras.onPaseo?.(paseo);
      return flow.execStart(input.card);
    });
    server.handle(rpc.execSwitchRpc, async (input, { paseo }) => {
      extras.onPaseo?.(paseo);
      return flow.execSwitch(input.card, input.presetId);
    });
  }
  if (verify) {
    server.handle(rpc.verifyGetRpc, (input) => verify.get(input.card, input.verificationId));
    server.handle(rpc.verifyListRpc, (input) => verify.list(input.card));
    server.handle(rpc.verifyEvidenceRpc, (input) => verify.evidence(input.evidenceId, input.thumb));
    server.handle(rpc.verifyApproveRpc, (input) => verify.approve(input.card));
    server.handle(rpc.verifyRejectRpc, (input) => verify.reject(input.card, input.comment));
    server.handle(rpc.verifyRerunRpc, (input) => verify.rerun(input.card));
  }
  if (sync) server.handle(rpc.syncExchangeRpc, (input) => sync.exchange(input as never));
  server.handle(rpc.localStatusRpc, () => ({ offline: false, asOf: Date.now(), replies: [] }));
  if (replies) {
    server.handle(rpc.replyCheckRpc, (input, { paseo }) => {
      extras.onPaseo?.(paseo);
      return replies.check(input);
    });
    server.handle(rpc.replySendRpc, (input, { paseo }) => {
      extras.onPaseo?.(paseo);
      return replies.send(input);
    });
  }
  if (dispatcher) {
    server.handle(rpc.cardsDispatchRpc, async ({ card, ...input }, { paseo }) => {
      extras.onPaseo?.(paseo);
      const { card: moved, session } = await dispatcher.dispatch(card, { ...input, force: true });
      return { card: moved, session };
    });
  }
  if (lifecycle) {
    server.handle(rpc.sessionsRecordSwitchRpc, (input) => ({
      session: lifecycle.recordSwitch(input) ?? null,
    }));
  }
}
