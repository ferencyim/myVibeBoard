// Board service: the single implementation behind the RPC handlers, the MCP tools and the CLI.
// All writes go through the vibe-shared command layer (createVibeStore): state-machine
// validation, HLC stamping and vibe_event publishing happen there.

import {
  CARD_COLUMNS,
  CARD_KEY_PATTERN,
  sortKeyBetween,
  StateMachineError,
  type AuthorKind,
  type CardColumn,
  type CardEventType,
  type CardPriority,
  type CardView,
  type MoveActor,
  type Project,
} from "./vibe/contract";
import {
  CommandError,
  createVibeStore,
  migrateOwner,
  openVibeDb,
  type VibeDb,
  type VibeStore,
} from "./vibe/db";
import { AttachmentError, createAttachments, type Attachments } from "./attachments";
import { CARDS_LIST_DEFAULT_LIMIT, type BoardCounts, type CardDetail } from "../shared/rpc";

/** Error surfaced to callers as `[code] message`. */
export class BoardError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "BoardError";
  }
}

/** Convert store/state-machine/attachment errors into BoardError; rethrow anything else. */
export function toBoardError(error: unknown): Error {
  if (error instanceof BoardError) return error;
  if (error instanceof CommandError) return new BoardError(error.code, error.message);
  if (error instanceof StateMachineError) return new BoardError(error.reason, error.message);
  if (error instanceof AttachmentError) return new BoardError(error.code, error.message);
  return error instanceof Error ? error : new Error(String(error));
}

export interface Actor {
  /** State-machine actor for moves/creates. */
  move: MoveActor;
  authorKind: AuthorKind;
  author: string;
}

export const USER_ACTOR: Actor = { move: "user", authorKind: "user", author: "user" };

/** Actor for an agent session (MCP/CLI called from inside an agent). */
export function agentActor(role: string | undefined, agentId: string | undefined): Actor {
  return {
    move: role === "verifier" ? "verifier" : "master",
    authorKind: "agent",
    author: agentId || role || "agent",
  };
}

export interface BoardRuntime {
  db: VibeDb;
  store: VibeStore;
  attachments: Attachments;
  close(): void;
}

export function openBoardRuntime(options: { path?: string; now?: () => Date } = {}): BoardRuntime {
  const db = openVibeDb(options.path ? { path: options.path } : {});
  migrateOwner(db, "core");
  const store = createVibeStore(db, options.now ? { now: options.now } : {});
  return { db, store, attachments: createAttachments(db, options.now), close: () => db.close() };
}

const emptyCounts = (): BoardCounts => ({ draft: 0, todo: 0, in_progress: 0, verifying: 0, done: 0 });

export interface CardListFilter {
  project?: string;
  column?: CardColumn;
  tagId?: string;
  priority?: CardPriority;
  search?: string;
  parentCardId?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface CardCreateInput {
  project: string;
  title: string;
  description?: string;
  column?: CardColumn;
  priority?: CardPriority;
  acceptance?: string;
  refImages?: string[];
  needsEvidence?: boolean;
  presetId?: string | null;
  reviewerPresetId?: string | null;
  scoutPresetId?: string | null;
  plannerPresetId?: string | null;
  planReviewerPresetId?: string | null;
  subagentPresetId?: string | null;
  verifierPresetId?: string | null;
  parentCardId?: string | null;
  tagIds?: string[];
  sortKey?: string;
}

export interface CardUpdateInput {
  title?: string;
  description?: string;
  priority?: CardPriority;
  acceptance?: string;
  refImages?: string[];
  needsEvidence?: boolean;
  presetId?: string | null;
  reviewerPresetId?: string | null;
  scoutPresetId?: string | null;
  plannerPresetId?: string | null;
  subagentPresetId?: string | null;
  planReviewerPresetId?: string | null;
  verifierPresetId?: string | null;
  planSeenAt?: string | null;
  execSeenAt?: string | null;
  reviewSeenAt?: string | null;
  verifySeenAt?: string | null;
  parentCardId?: string | null;
  tagIds?: string[];
}

export function createBoardService(runtime: BoardRuntime) {
  const { db, store, attachments } = runtime;

  // ---- lookups ----

  function project(ref: string): Project {
    const found =
      store.projects.get(ref) ??
      store.projects.list(true).find((p) => p.prefix === ref.toUpperCase() || p.name === ref);
    if (!found) throw new BoardError("not_found", `找不到项目：${ref}`);
    return found;
  }

  function card(ref: string): CardView {
    const found = store.cards.get(CARD_KEY_PATTERN.test(ref.toUpperCase()) ? ref.toUpperCase() : ref);
    if (!found) throw new BoardError("not_found", `找不到卡片：${ref}`);
    return found;
  }

  const guard = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      throw toBoardError(error);
    }
  };

  // ---- projects ----

  const projects = {
    list: (includeArchived = false) => ({ projects: store.projects.list(includeArchived) }),
    create: (input: Parameters<typeof store.projects.create>[0]) =>
      guard(() => ({ project: store.projects.create(input) })),
    update(ref: string, patch: Parameters<typeof store.projects.update>[1]) {
      return guard(() => ({ project: store.projects.update(project(ref).id, patch) }));
    },
    resolve: (ref: string) => guard(() => project(ref)),
  };

  // ---- cards ----

  function summary() {
    const rows = db
      .prepare<{ project_id: string; column: CardColumn; n: number }>(
        `SELECT project_id, "column" AS "column", COUNT(*) AS n FROM card WHERE archived_at IS NULL GROUP BY project_id, "column"`,
      )
      .all();
    const totals = emptyCounts();
    const byProject = new Map<string, BoardCounts>();
    for (const row of rows) {
      const counts = byProject.get(row.project_id) ?? emptyCounts();
      counts[row.column] += row.n;
      totals[row.column] += row.n;
      byProject.set(row.project_id, counts);
    }
    return {
      projects: store.projects.list().map((p) => ({
        projectId: p.id,
        prefix: p.prefix,
        name: p.name,
        counts: byProject.get(p.id) ?? emptyCounts(),
      })),
      totals,
    };
  }

  function list(filter: CardListFilter = {}) {
    return guard(() => {
      const search = filter.search?.trim().toLowerCase();
      let cards = store.cards.list({
        projectId: filter.project ? project(filter.project).id : undefined,
        column: filter.column,
        tagId: filter.tagId,
        parentCardId: filter.parentCardId,
        includeArchived: filter.includeArchived,
      });
      if (filter.priority) cards = cards.filter((c) => c.priority === filter.priority);
      if (search) {
        cards = cards.filter((c) =>
          `${c.key}\n${c.title}\n${c.description}`.toLowerCase().includes(search),
        );
      }
      const limit = filter.limit ?? CARDS_LIST_DEFAULT_LIMIT;
      return { cards: cards.slice(0, limit), truncated: cards.length > limit };
    });
  }

  function detail(ref: string): CardDetail {
    return guard(() => {
      const c = card(ref);
      return {
        card: c,
        events: store.events.list(c.id),
        attachments: attachments.list(c.id),
        plans: store.plans.list(c.id),
        children: store.cards.list({ parentCardId: c.id, includeArchived: true }),
        sessions: store.sessions.list({ cardId: c.id }),
      };
    });
  }

  function create(input: CardCreateInput, actor: Actor = USER_ACTOR) {
    return guard(() => ({
      card: db.immediate(() => {
        const p = project(input.project);
        if (input.parentCardId) {
          const parent = card(input.parentCardId);
          if (parent.projectId !== p.id) {
            throw new BoardError("invalid", "父卡片属于另一个项目");
          }
        }
        return store.cards.create(
          {
            projectId: p.id,
            title: input.title,
            description: input.description,
            column: input.column,
            priority: input.priority,
            acceptance: input.acceptance,
            refImages: input.refImages,
            needsEvidence: input.needsEvidence,
            presetId: input.presetId,
            reviewerPresetId: input.reviewerPresetId,
            scoutPresetId: input.scoutPresetId,
            plannerPresetId: input.plannerPresetId,
            planReviewerPresetId: input.planReviewerPresetId,
            subagentPresetId: input.subagentPresetId,
            verifierPresetId: input.verifierPresetId,
            parentCardId: input.parentCardId ? card(input.parentCardId).id : undefined,
            tagIds: input.tagIds,
            sortKey: input.sortKey,
          },
          actor.move,
          actor.author,
        );
      }),
    }));
  }

  function update(ref: string, patch: CardUpdateInput) {
    return guard(() => ({
      card: db.immediate(() => {
        const current = card(ref);
        const { tagIds, parentCardId, ...rest } = patch;
        let parentId: string | null | undefined;
        if (parentCardId !== undefined) {
          parentId = parentCardId === null ? null : card(parentCardId).id;
          if (parentId === current.id) throw new BoardError("invalid", "卡片不能是自己的父卡片");
        }
        let result = store.cards.update(current.id, { ...rest, parentCardId: parentId });
        if (tagIds) result = store.cards.setTags(current.id, tagIds);
        return result;
      }),
    }));
  }

  function move(
    ref: string,
    input: { to: CardColumn; actor?: MoveActor; reason?: string; sortKey?: string },
  ) {
    return guard(() => ({
      card: store.cards.move(card(ref).id, {
        to: input.to,
        actor: input.actor ?? "user",
        reason: input.reason,
        sortKey: input.sortKey,
      }),
    }));
  }

  function reorder(
    ref: string,
    input: { sortKey?: string; afterCard?: string | null; beforeCard?: string | null },
  ) {
    return guard(() => {
      const c = card(ref);
      let sortKey = input.sortKey;
      if (!sortKey) {
        const after = input.afterCard ? card(input.afterCard) : null;
        const before = input.beforeCard ? card(input.beforeCard) : null;
        for (const neighbour of [after, before]) {
          if (neighbour && (neighbour.projectId !== c.projectId || neighbour.column !== c.column)) {
            throw new BoardError("invalid", "相邻的卡片必须在同一个项目和同一列");
          }
        }
        try {
          sortKey = sortKeyBetween(after?.sortKey ?? null, before?.sortKey ?? null);
        } catch {
          throw new BoardError("invalid", "afterCard 必须排在 beforeCard 前面");
        }
      }
      return { card: store.cards.reorder(c.id, sortKey) };
    });
  }

  // ---- events / plans ----

  function addEvent(
    ref: string,
    input: { type?: CardEventType; text?: string; body?: unknown; authorKind?: AuthorKind; author?: string },
    actor: Actor = USER_ACTOR,
  ) {
    return guard(() => {
      const body = input.body ?? (input.text !== undefined ? { text: input.text } : undefined);
      if (body === undefined) throw new BoardError("invalid", "需要提供 text 或 body");
      return {
        event: store.events.add({
          cardId: card(ref).id,
          type: input.type ?? "note",
          authorKind: input.authorKind ?? actor.authorKind,
          author: input.author ?? actor.author,
          body,
        }),
      };
    });
  }

  // ---- attachments ----

  function uploadAttachment(
    ref: string,
    input: { fileName: string; bytes: Uint8Array; mime?: string; cardEventId?: string; asRefImage?: boolean },
  ) {
    return guard(() =>
      db.immediate(() => {
        const c = card(ref);
        const attachment = attachments.create(c.id, input.bytes, {
          fileName: input.fileName,
          mime: input.mime,
          cardEventId: input.cardEventId,
        });
        if (input.asRefImage) store.cards.update(c.id, { refImages: [...c.refImages, attachment.id] });
        return { attachment };
      }),
    );
  }

  function deleteAttachment(attachmentId: string) {
    return guard(() =>
      db.immediate(() => {
        const attachment = attachments.get(attachmentId);
        if (!attachment) return { deleted: false };
        const c = store.cards.get(attachment.cardId);
        if (c?.refImages.includes(attachmentId)) {
          store.cards.update(c.id, { refImages: c.refImages.filter((id) => id !== attachmentId) });
        }
        return { deleted: attachments.delete(attachmentId) };
      }),
    );
  }

  return {
    projects,
    cards: { summary, list, detail, create, update, move, reorder, get: (ref: string) => guard(() => card(ref)) },
    events: { list: (ref: string) => guard(() => ({ events: store.events.list(card(ref).id) })), add: addEvent },
    plans: {
      list: (ref: string) => guard(() => ({ versions: store.plans.list(card(ref).id) })),
      save: (ref: string, snapshot: Parameters<typeof store.plans.save>[1]) =>
        guard(() => ({ version: store.plans.save(card(ref).id, snapshot) })),
    },
    archive: (ref: string, archived = true) => guard(() => ({ card: store.cards.archive(card(ref).id, archived) })),
    remove: (ref: string) =>
      guard(() => {
        store.cards.delete(card(ref).id);
        return { deleted: true };
      }),
    tags: {
      list: () => ({ tags: store.tags.list() }),
      create: (name: string, evidence?: boolean, color?: string) =>
        guard(() => ({ tag: store.tags.create(name, evidence, undefined, color) })),
      update: (tagId: string, patch: { name?: string; evidence?: boolean; color?: string }) =>
        guard(() => ({ tag: store.tags.update(tagId, patch) })),
      delete: (tagId: string) =>
        guard(() => {
          store.tags.delete(tagId);
          return { deleted: true };
        }),
    },
    presets: {
      list: () => ({ presets: store.presets.list() }),
      create: (input: Parameters<typeof store.presets.create>[0]) =>
        guard(() => {
          if (!input.model?.trim()) throw new BoardError("invalid", "预设必须填写模型");
          return { preset: store.presets.create(input) };
        }),
      update: (id: string, patch: Parameters<typeof store.presets.update>[1]) =>
        guard(() => {
          if (patch.model !== undefined && !patch.model.trim()) throw new BoardError("invalid", "预设必须填写模型");
          return { preset: store.presets.update(id, patch) };
        }),
      delete: (id: string) =>
        guard(() => {
          store.presets.delete(id);
          return { deleted: true };
        }),
    },
    /** Global default model per job (WP-108); the project level is a project field. */
    defaults: {
      get: () => ({ global: store.modelDefaults.global() }),
      set: (global: Parameters<typeof store.modelDefaults.setGlobal>[0]) =>
        guard(() => ({ global: store.modelDefaults.setGlobal(global) })),
    },
    /** Agent behaviour page (WP-98): every registered prompt with its overrides. */
    prompts: {
      list: (projectId?: string | null) =>
        guard(() => ({
          prompts: store.prompts.list({ projectId: projectId ?? null }),
          projects: store.projects.list(false).map((p) => ({ id: p.id, name: p.name, prefix: p.prefix })),
        })),
      /** Blank text clears the override. */
      set: (key: string, text: string, projectId?: string | null) =>
        guard(() => {
          store.prompts.setOverride(key, text, { projectId: projectId ?? null });
          return { ok: true as const };
        }),
      clear: (key: string, projectId?: string | null) =>
        guard(() => {
          store.prompts.clearOverride(key, { projectId: projectId ?? null });
          return { ok: true as const };
        }),
    },
    sessions: {
      list: (ref?: string) => guard(() => ({ sessions: store.sessions.list(ref ? { cardId: card(ref).id } : {}) })),
    },
    attachments: {
      list: (ref: string) => guard(() => ({ attachments: attachments.list(card(ref).id) })),
      upload: uploadAttachment,
      read: (id: string) => guard(() => attachments.read(id)),
      delete: deleteAttachment,
    },
    columns: CARD_COLUMNS,
    store,
  };
}

export type BoardService = ReturnType<typeof createBoardService>;
