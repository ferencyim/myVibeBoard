// Optimistic card edits: a pick (priority, tags, preset, reviewer, evidence) shows in the UI at
// once while the write and the follow-up refetch run in the background. Writes are chained so
// they reach the server in click order; a failed write rolls its value back.
//
// Before: update() awaited the RPC, then reload() invalidated every board query (including the
// 2000-card list) and refetched the detail; the selection only changed after that whole chain,
// so every tap on the preset / reviewer chips looked frozen and a second tap raced the first.

import { useCallback, useMemo, useRef, useState } from "react";
import type { CardView } from "../../shared/vibe/contract";

/** Card fields the pickers change, keyed the way the update RPC names them. */
type CardPatch = {
  priority?: CardView["priority"];
  tagIds?: string[];
  presetId?: string | null;
  reviewerPresetId?: string | null;
  scoutPresetId?: string | null;
  plannerPresetId?: string | null;
  subagentPresetId?: string | null;
  planReviewerPresetId?: string | null;
  verifierPresetId?: string | null;
  needsEvidence?: boolean;
  [other: string]: unknown;
};

const OPTIMISTIC_KEYS = [
  "priority",
  "tagIds",
  "presetId",
  "reviewerPresetId",
  "scoutPresetId",
  "plannerPresetId",
  "subagentPresetId",
  "planReviewerPresetId",
  "verifierPresetId",
  "needsEvidence",
] as const;
type OptimisticKey = (typeof OPTIMISTIC_KEYS)[number];

interface Pending {
  value: unknown;
  seq: number;
}
export type PendingMap = Partial<Record<OptimisticKey, Pending>>;

/** The card as the user sees it: server state with the not-yet-confirmed picks laid over it. */
export function applyPending(card: CardView, pending: PendingMap): CardView {
  const keys = Object.keys(pending) as OptimisticKey[];
  if (keys.length === 0) return card;
  const next: Record<string, unknown> = { ...card };
  for (const key of keys) next[key === "tagIds" ? "tags" : key] = pending[key]!.value;
  return next as unknown as CardView;
}

/** Drop the entries a finished write owned (a newer pick of the same field keeps its entry). */
export function settle(pending: PendingMap, owned: Partial<Record<OptimisticKey, number>>): PendingMap {
  const next: PendingMap = { ...pending };
  for (const key of Object.keys(owned) as OptimisticKey[]) {
    if (next[key]?.seq === owned[key]) delete next[key];
  }
  return next;
}

export function useOptimisticCard(
  server: CardView,
  send: (patch: CardPatch) => Promise<unknown>,
  /** Refetches the card; resolves once the server value is back. */
  refetch: () => Promise<unknown>,
  onError: (error: unknown) => void,
) {
  const [pending, setPending] = useState<PendingMap>({});
  const chain = useRef<Promise<void>>(Promise.resolve());
  const seq = useRef(0);
  const card = useMemo(() => applyPending(server, pending), [server, pending]);

  const update = useCallback(
    (patch: CardPatch) => {
      const owned: Partial<Record<OptimisticKey, number>> = {};
      const mine: PendingMap = {};
      for (const key of OPTIMISTIC_KEYS) {
        if (!(key in patch)) continue;
        owned[key] = ++seq.current;
        mine[key] = { value: patch[key], seq: owned[key]! };
      }
      if (Object.keys(mine).length > 0) setPending((p) => ({ ...p, ...mine }));
      const run = chain.current.then(async () => {
        try {
          await send(patch);
          await refetch();
        } catch (e) {
          onError(e);
        } finally {
          setPending((p) => settle(p, owned));
        }
      });
      chain.current = run;
      return run;
    },
    [send, refetch, onError],
  );

  return { card, update };
}
