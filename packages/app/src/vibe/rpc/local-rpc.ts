// Offline implementation of vibe-board's board RPCs on top of the local replica. Reads answer
// with the daemon's shapes (rows.ts); writes go through ClientSync so they carry HLCs, land in the
// outbox and reach the daemon with the next exchange. The App cannot import the plugin's RPC
// contract, so the input shapes below mirror plugins/vibe-board/shared/rpc (kept in step by
// local-rpc.test.ts, which parses every answer with that contract).

import {
  checkTransition,
  newId,
  type CardColumn,
  type CardEvent,
  type CardView,
} from "../generated/contract";
import {
  PHONE_MOVABLE_COLUMNS,
  generateSortKey,
  type ClientSync,
  type JsonValue,
} from "../generated/sync";
import { queueReply, visibleReplies } from "../replies/queue";
import type { LocalReplica } from "../store/replica";
import {
  liveRows,
  provisionalKey,
  toCard,
  toEvent,
  toPlan,
  toPreset,
  toProject,
  toSession,
  toTag,
  type RawRow,
} from "./rows";

export const VIBE_BOARD_PLUGIN_ID = "vibe-board";

/** Thrown for RPCs the phone cannot answer without the daemon. */
export class OfflineRpcError extends Error {
  constructor(method: string) {
    super(`[offline] ${method} needs a connection to your computer`);
    this.name = "OfflineRpcError";
  }
}

class RpcError extends Error {
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
  }
}

type Input = Record<string, unknown>;
type Counts = Record<CardColumn, number>;
const zeroCounts = (): Counts => ({ draft: 0, todo: 0, in_progress: 0, verifying: 0, done: 0 });
const DEFAULT_LIMIT = 500;

function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
const byOrder = (a: CardView, b: CardView) => byText(a.sortKey, b.sortKey) || byText(a.id, b.id);

export interface LocalRpcOptions {
  now?: () => number;
  random?: () => number;
}

export function createLocalVibeRpc(replica: LocalReplica, options: LocalRpcOptions = {}) {
  const now = options.now ?? Date.now;
  const store = replica.store;
  const rowsOf = (table: string) => liveRows(store, table);
  const isoNow = () => new Date(now()).toISOString();
  const asString = (x: unknown) => (typeof x === "string" ? x : undefined);

  // ---- snapshot of the replica for one call ----

  function load() {
    const projects = rowsOf("project");
    const prefixOf = new Map(projects.map((p) => [p.id, toProject(p).prefix]));
    const tagsOf = new Map<string, string[]>();
    for (const m of rowsOf("card_tag")) {
      const [cardId = "", tagId = ""] = m.id.split(":");
      tagsOf.set(cardId, [...(tagsOf.get(cardId) ?? []), tagId]);
    }
    const cardRows = rowsOf("card");
    const cards = cardRows
      .map((r) =>
        toCard(r, prefixOf.get(String(r.v.project_id)) ?? "?", (tagsOf.get(r.id) ?? []).sort()),
      )
      .sort(byOrder);
    return { projects, prefixOf, cards, cardRows: new Map(cardRows.map((r) => [r.id, r])) };
  }
  type Snapshot = ReturnType<typeof load>;

  function projectOf(s: Snapshot, ref: string): RawRow {
    const found =
      s.projects.find((p) => p.id === ref) ??
      s.projects.find((p) => toProject(p).prefix === ref.toUpperCase() || p.v.name === ref);
    if (!found) throw new RpcError("not_found", `Project not found: ${ref}`);
    return found;
  }

  function cardOf(s: Snapshot, ref: string): CardView {
    const key = ref.toUpperCase();
    const found = s.cards.find(
      (c) =>
        c.id === ref ||
        c.key.toUpperCase() === key ||
        provisionalKey(s.prefixOf.get(c.projectId) ?? "?", c.id).toUpperCase() === key,
    );
    if (!found) throw new RpcError("not_found", `Card not found: ${ref}`);
    return found;
  }

  // ---- reads ----

  const projectsList = (i: Input) => ({
    projects: rowsOf("project")
      .map(toProject)
      .filter((p) => i.includeArchived === true || p.archivedAt === null)
      .sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id)),
  });

  function boardSummary() {
    const totals = zeroCounts();
    const byProject = new Map<string, Counts>();
    for (const c of load().cards) {
      if (c.archivedAt !== null) continue;
      const counts = byProject.get(c.projectId) ?? zeroCounts();
      counts[c.column] += 1;
      totals[c.column] += 1;
      byProject.set(c.projectId, counts);
    }
    return {
      projects: projectsList({}).projects.map((p) => ({
        projectId: p.id,
        prefix: p.prefix,
        name: p.name,
        counts: byProject.get(p.id) ?? zeroCounts(),
      })),
      totals,
    };
  }

  function cardsList(i: Input) {
    const s = load();
    const projectId = typeof i.project === "string" ? projectOf(s, i.project).id : undefined;
    const search = typeof i.search === "string" ? i.search.trim().toLowerCase() : "";
    const cards = s.cards.filter(
      (c) =>
        (i.includeArchived === true || c.archivedAt === null) &&
        (projectId === undefined || c.projectId === projectId) &&
        (i.column === undefined || c.column === i.column) &&
        (i.tagId === undefined || c.tags.includes(i.tagId as string)) &&
        (i.priority === undefined || c.priority === i.priority) &&
        (i.parentCardId === undefined || c.parentCardId === i.parentCardId) &&
        (!search || `${c.key}\n${c.title}\n${c.description}`.toLowerCase().includes(search)),
    );
    const limit = typeof i.limit === "number" ? i.limit : DEFAULT_LIMIT;
    return { cards: cards.slice(0, limit), truncated: cards.length > limit };
  }

  const eventsOf = (cardId: string): CardEvent[] =>
    rowsOf("card_event")
      .filter((r) => r.v.card_id === cardId)
      .map(toEvent)
      .sort((a, b) => byText(a.createdAt, b.createdAt) || byText(a.id, b.id));
  const plansOf = (cardId: string) =>
    rowsOf("plan_version")
      .filter((r) => r.v.card_id === cardId)
      .map(toPlan)
      .sort((a, b) => a.version - b.version);
  const sessionsOf = (cardId?: string) =>
    rowsOf("agent_session")
      .filter((r) => cardId === undefined || r.v.card_id === cardId)
      .map(toSession)
      .sort((a, b) => byText(a.startedAt, b.startedAt) || byText(a.id, b.id));

  function cardsGet(i: Input) {
    const s = load();
    const card = cardOf(s, String(i.card));
    return {
      card,
      events: eventsOf(card.id),
      attachments: [],
      plans: plansOf(card.id),
      children: s.cards.filter((c) => c.parentCardId === card.id),
      sessions: sessionsOf(card.id),
    };
  }

  // ---- writes ----

  const cardResult = (id: string) => ({ card: cardOf(load(), id) });

  function assertTagsExist(tagIds: string[]): void {
    const known = new Set(rowsOf("tag").map((t) => t.id));
    const missing = tagIds.find((id) => !known.has(id));
    if (missing) throw new RpcError("not_found", `Tag not found: ${missing}`);
  }

  function setTags(sync: ClientSync, cardId: string, wanted: string[]): void {
    const have = new Set(
      rowsOf("card_tag")
        .map((m) => m.id.split(":"))
        .filter(([c]) => c === cardId)
        .map(([, t]) => t as string),
    );
    for (const t of wanted) if (!have.has(t)) sync.write("card_tag", `${cardId}:${t}`, {});
    for (const t of have) if (!wanted.includes(t)) sync.remove("card_tag", `${cardId}:${t}`);
  }

  /** Editable card fields -> synced columns (only the ones present in the input). */
  function cardColumns(i: Input): Record<string, JsonValue> {
    const out: Record<string, JsonValue> = {};
    if (typeof i.title === "string") {
      if (!i.title.trim()) throw new RpcError("invalid", "Title must not be blank");
      out.title = i.title;
    }
    for (const key of ["description", "acceptance", "priority"] as const) {
      const value = asString(i[key]);
      if (value !== undefined) out[key] = value;
    }
    if (Array.isArray(i.refImages)) out.ref_images_json = JSON.stringify(i.refImages);
    if (typeof i.needsEvidence === "boolean") out.needs_evidence = i.needsEvidence ? 1 : 0;
    if (i.presetId !== undefined) out.preset_id = asString(i.presetId) ?? null;
    return out;
  }

  function endKey(s: Snapshot, projectId: string, column: CardColumn, skipId?: string): string {
    // s.cards is in board order, so the last match holds the largest sort key.
    const last = s.cards.findLast(
      (c) => c.projectId === projectId && c.column === column && c.id !== skipId,
    );
    return generateSortKey(last?.sortKey ?? null, null, { random: options.random });
  }

  function cardsCreate(i: Input) {
    const s = load();
    const project = projectOf(s, String(i.project));
    const column = (i.column ?? "draft") as CardColumn;
    if (!PHONE_MOVABLE_COLUMNS.includes(column)) {
      throw new RpcError("actor_not_allowed", "New cards start in draft or todo");
    }
    const values = cardColumns(i);
    if (values.title === undefined) throw new RpcError("invalid", "Title is required");
    const tagIds = Array.isArray(i.tagIds) ? (i.tagIds as string[]) : [];
    assertTagsExist(tagIds);
    let parentId: string | null = null;
    if (typeof i.parentCardId === "string") {
      const parent = cardOf(s, i.parentCardId);
      if (parent.projectId !== project.id) {
        throw new RpcError("invalid", "Parent card belongs to another project");
      }
      parentId = parent.id;
    }
    const id = newId(now());
    replica.mutate((sync) => {
      sync.write("card", id, {
        description: "",
        acceptance: "",
        priority: "none",
        ref_images_json: "[]",
        needs_evidence: 0,
        preset_id: null,
        archived_at: null,
        ...values,
        project_id: project.id,
        parent_card_id: parentId,
        column,
        sort_key: asString(i.sortKey) ?? endKey(s, project.id, column),
      });
      setTags(sync, id, tagIds);
    });
    return cardResult(id);
  }

  function cardsUpdate(i: Input) {
    const s = load();
    const card = cardOf(s, String(i.card));
    const values = cardColumns(i);
    if (i.parentCardId !== undefined) {
      const parent = i.parentCardId === null ? null : cardOf(s, String(i.parentCardId));
      if (parent && (parent.id === card.id || parent.projectId !== card.projectId)) {
        throw new RpcError("invalid", "Invalid parent card");
      }
      values.parent_card_id = parent?.id ?? null;
    }
    const current = s.cardRows.get(card.id)?.v ?? {};
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => current[k] !== v));
    const tagIds = Array.isArray(i.tagIds) ? (i.tagIds as string[]) : undefined;
    if (tagIds) assertTagsExist(tagIds);
    replica.mutate((sync) => {
      if (Object.keys(changed).length) sync.write("card", card.id, changed);
      if (tagIds) setTags(sync, card.id, tagIds);
    });
    return cardResult(card.id);
  }

  function cardsMove(i: Input) {
    const s = load();
    const card = cardOf(s, String(i.card));
    const to = i.to as CardColumn;
    const verdict = checkTransition(card.column, to, "phone");
    if (!verdict.ok) throw new RpcError(verdict.reason, verdict.message);
    const sortKey = asString(i.sortKey) ?? endKey(s, card.projectId, to, card.id);
    replica.mutate((sync) => sync.write("card", card.id, { column: to, sort_key: sortKey }));
    return cardResult(card.id);
  }

  function cardsReorder(i: Input) {
    const s = load();
    const card = cardOf(s, String(i.card));
    if (!PHONE_MOVABLE_COLUMNS.includes(card.column)) {
      throw new RpcError("actor_not_allowed", "Only draft and todo cards can be reordered offline");
    }
    let sortKey = asString(i.sortKey);
    if (!sortKey) {
      const neighbour = (ref: unknown) => {
        if (typeof ref !== "string") return null;
        const n = cardOf(s, ref);
        if (n.projectId !== card.projectId || n.column !== card.column) {
          throw new RpcError("invalid", "Neighbour cards must be in the same project and column");
        }
        return n;
      };
      const after = neighbour(i.afterCard);
      const before = neighbour(i.beforeCard);
      if (after && before && after.sortKey >= before.sortKey) {
        throw new RpcError("invalid", "afterCard must sort before beforeCard");
      }
      sortKey = generateSortKey(after?.sortKey ?? null, before?.sortKey ?? null, {
        random: options.random,
      });
    }
    const key = sortKey;
    replica.mutate((sync) => sync.write("card", card.id, { sort_key: key }));
    return cardResult(card.id);
  }

  function cardsArchive(i: Input) {
    const card = cardOf(load(), String(i.card));
    const archivedAt = i.archived === false ? null : isoNow();
    replica.mutate((sync) => sync.write("card", card.id, { archived_at: archivedAt }));
    return cardResult(card.id);
  }

  function cardsDelete(i: Input) {
    const card = cardOf(load(), String(i.card));
    if (card.column !== "draft") {
      throw new RpcError("invalid", "Only draft cards can be deleted; archive others");
    }
    if (sessionsOf(card.id).length > 0) {
      throw new RpcError("invalid", "Cards that already ran cannot be deleted; archive them");
    }
    replica.mutate((sync) => sync.remove("card", card.id));
    return { deleted: true };
  }

  function eventsAdd(i: Input) {
    const card = cardOf(load(), String(i.card));
    const type = asString(i.type) ?? "note";
    if (type !== "note") throw new RpcError("actor_not_allowed", "Only notes can be added offline");
    const body = i.body ?? (typeof i.text === "string" ? { text: i.text } : undefined);
    if (body === undefined) throw new RpcError("invalid", "text or body is required");
    const id = newId(now());
    replica.mutate((sync) =>
      sync.write("card_event", id, {
        card_id: card.id,
        type,
        author_kind: "user",
        author: "user",
        created_at: isoNow(),
        body_json: JSON.stringify(body),
      }),
    );
    return { event: toEvent(rowsOf("card_event").find((r) => r.id === id) as RawRow) };
  }

  function replySend(i: Input) {
    const card = cardOf(load(), String(i.cardId));
    queueReply(
      replica,
      {
        id: asString(i.id),
        cardId: card.id,
        questionId: String(i.questionId),
        text: String(i.text ?? ""),
      },
      now(),
    );
    // Not delivered yet: the sync engine sends it after reconnecting, if the question is still open.
    return { sent: false, duplicate: false };
  }

  const handlers: Record<string, (input: Input) => unknown> = {
    "vibe.local.status": () => ({
      offline: true,
      asOf: replica.asOf,
      replies: visibleReplies(replica),
    }),
    "vibe.reply.send": replySend,
    "vibe.projects.list": projectsList,
    "vibe.board.summary": boardSummary,
    "vibe.cards.list": cardsList,
    "vibe.cards.get": cardsGet,
    "vibe.tags.list": () => ({
      tags: rowsOf("tag")
        .map(toTag)
        .sort((a, b) => Number(b.builtin) - Number(a.builtin) || byText(a.name, b.name)),
    }),
    "vibe.presets.list": () => ({
      presets: rowsOf("preset")
        .map(toPreset)
        .sort((a, b) => byText(a.name, b.name)),
    }),
    "vibe.events.list": (i) => ({ events: eventsOf(cardOf(load(), String(i.card)).id) }),
    "vibe.plans.list": (i) => ({ versions: plansOf(cardOf(load(), String(i.card)).id) }),
    "vibe.sessions.list": (i) => ({
      sessions: sessionsOf(i.card === undefined ? undefined : cardOf(load(), String(i.card)).id),
    }),
    "vibe.attachments.list": () => ({ attachments: [] }),
    "vibe.cards.create": cardsCreate,
    "vibe.cards.update": cardsUpdate,
    "vibe.cards.move": cardsMove,
    "vibe.cards.reorder": cardsReorder,
    "vibe.cards.archive": cardsArchive,
    "vibe.cards.delete": cardsDelete,
    "vibe.events.add": eventsAdd,
  };

  return {
    methods: Object.keys(handlers),
    async invoke(method: string, input: unknown): Promise<unknown> {
      const handler = handlers[method];
      if (!handler) throw new OfflineRpcError(method);
      return handler((input ?? {}) as Input);
    },
  };
}

export type LocalVibeRpc = ReturnType<typeof createLocalVibeRpc>;
