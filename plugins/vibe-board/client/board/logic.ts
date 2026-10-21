// Pure board logic (filtering, grouping, drag targets). No React / react-native imports so it is
// unit-testable in plain node.

import {
  CARD_COLUMNS,
  allowedTargets,
  checkTransition,
  type CardColumn,
  type CardPriority,
  type CardView,
  type Preset,
  type Project,
  type Tag,
} from "../../shared/vibe/contract";
import { formatRpcError } from "../../shared/vibe/ui/rpc-error";

export const COLUMN_LABELS: Record<CardColumn, string> = {
  draft: "草稿箱",
  todo: "待办",
  in_progress: "进行中",
  verifying: "待验证",
  done: "已完成",
};

export const PRIORITY_LABELS: Record<CardPriority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
  none: "无",
};

const PROJECT_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

/** Project color: its own `color` (hex) or a stable palette pick by position. */
export function projectColor(project: Pick<Project, "color">, index: number): string {
  const c = project.color?.trim();
  if (c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) return c;
  const n = PROJECT_PALETTE.length;
  return PROJECT_PALETTE[((index % n) + n) % n]!;
}

export interface CardFilter {
  /** null / undefined = all projects (general board). */
  projectId?: string | null;
  search?: string;
  priority?: CardPriority | null;
  tagId?: string | null;
}

export function filterCards(cards: readonly CardView[], filter: CardFilter): CardView[] {
  const q = filter.search?.trim().toLowerCase() ?? "";
  return cards.filter((card) => {
    if (filter.projectId && card.projectId !== filter.projectId) return false;
    if (filter.priority && card.priority !== filter.priority) return false;
    if (filter.tagId && !card.tags.includes(filter.tagId)) return false;
    if (q) {
      const hay = `${card.key} ${card.title} ${card.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Cards grouped by column, each ordered by sortKey (key breaks ties). */
export function groupByColumn(cards: readonly CardView[]): Record<CardColumn, CardView[]> {
  const out = Object.fromEntries(CARD_COLUMNS.map((c) => [c, [] as CardView[]])) as Record<
    CardColumn,
    CardView[]
  >;
  for (const card of cards) out[card.column].push(card);
  for (const column of CARD_COLUMNS) {
    out[column].sort((a, b) =>
      a.sortKey === b.sortKey ? a.key.localeCompare(b.key) : a.sortKey < b.sortKey ? -1 : 1,
    );
  }
  return out;
}

/** Cheap change detector for polled lists: equal fingerprint = nothing visible changed. */
export function cardsFingerprint(cards: readonly CardView[]): string {
  return cards
    .map((c) => `${c.id}:${c.updatedHlc || c.updatedAt}:${c.column}:${c.sortKey}`)
    .join("|");
}

/** Chinese, user-facing text of an RPC error (no `Request failed:`, `[code]` or requestType/code noise). */
export const errorMessage = formatRpcError;

// --- needs_evidence ------------------------------------------------------------------------

/** Default for "needs verification evidence": any selected tag with evidence=true (feature, change). */
export function evidenceDefault(tagIds: readonly string[], tags: readonly Tag[]): boolean {
  return tags.some((t) => t.evidence && tagIds.includes(t.id));
}

// --- preset recommendation -----------------------------------------------------------------

export interface PresetChoice {
  /** The preset used for dispatch (user's pick, else the master's recommendation). */
  effectiveId: string | null;
  /** User picked X but the master agent recommends Y: show both and let the user decide. */
  conflict: boolean;
  user: Preset | null;
  suggested: Preset | null;
}

export function resolvePresetChoice(
  card: Pick<CardView, "presetId" | "suggestedPresetId">,
  presets: readonly Preset[],
): PresetChoice {
  const byId = (id: string | null) => presets.find((p) => p.id === id) ?? null;
  const user = byId(card.presetId);
  const suggested = byId(card.suggestedPresetId);
  const conflict = !!user && !!suggested && user.id !== suggested.id;
  return { effectiveId: user?.id ?? suggested?.id ?? null, conflict, user, suggested };
}

// --- drag & drop ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Column whose horizontal span contains `x` (columns can be short, so y is ignored). */
export function columnAtX(
  x: number,
  columns: ReadonlyArray<{ column: CardColumn; rect: Rect }>,
): CardColumn | null {
  const hit = columns.find((c) => x >= c.rect.x && x <= c.rect.x + c.rect.width);
  return hit?.column ?? null;
}

/** Insert position among the (other) cards of the target column, by comparing y to card midpoints. */
export function insertIndexAtY(y: number, itemRects: readonly Rect[]): number {
  let index = 0;
  for (const r of itemRects) {
    if (y > r.y + r.height / 2) index += 1;
    else break;
  }
  return index;
}

export type DropPlan =
  | { type: "none" }
  | { type: "illegal"; message: string }
  | { type: "reorder"; afterCard: string | null; beforeCard: string | null }
  | {
      type: "move";
      to: CardColumn;
      /** Present when the card must be placed somewhere other than the column end. */
      place: { afterCard: string | null; beforeCard: string | null } | null;
    };

/**
 * Plan what a drop does. `targetCards` is the target column in board order (may include `card`
 * when the drop stays in its own column); `insertIndex` counts positions among the others.
 */
export function planDrop(
  card: Pick<CardView, "id" | "column">,
  toColumn: CardColumn,
  insertIndex: number,
  targetCards: readonly Pick<CardView, "id">[],
): DropPlan {
  const others = targetCards.filter((c) => c.id !== card.id);
  const index = Math.max(0, Math.min(insertIndex, others.length));
  const afterCard = others[index - 1]?.id ?? null;
  const beforeCard = others[index]?.id ?? null;
  if (toColumn === card.column) {
    const current = targetCards.findIndex((c) => c.id === card.id);
    return current === index ? { type: "none" } : { type: "reorder", afterCard, beforeCard };
  }
  const verdict = checkTransition(card.column, toColumn, "user");
  if (!verdict.ok) return { type: "illegal", message: verdict.message };
  return {
    type: "move",
    to: toColumn,
    place: index >= others.length ? null : { afterCard, beforeCard },
  };
}

/** Neighbours for "move up/down/top/bottom" menu actions; null when it would not change anything. */
export function stepNeighbours(
  columnCards: readonly Pick<CardView, "id">[],
  cardId: string,
  step: "up" | "down" | "top" | "bottom",
): { afterCard: string | null; beforeCard: string | null } | null {
  const i = columnCards.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  const others = columnCards.filter((c) => c.id !== cardId);
  const target =
    step === "top" ? 0 : step === "bottom" ? others.length : step === "up" ? i - 1 : i + 1;
  if (target < 0 || target > others.length || target === i) return null;
  return { afterCard: others[target - 1]?.id ?? null, beforeCard: others[target]?.id ?? null };
}

/** Columns a user may move this card to (Move-to menu, drag highlight). */
export function userTargets(column: CardColumn): CardColumn[] {
  return allowedTargets(column, "user");
}
