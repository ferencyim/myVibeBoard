// What wakes the master. Everything arrives as vibe_event rows (the shared bus), nothing calls
// another plugin:
//   card.created (draft) / card.updated (owner fields of a draft) / card.moved -> draft
//        -> assess_draft after a quiet period (default 30 s), restarted by every further edit
//   card.moved -> done                         -> card_done (memory consolidation)
//   session.waiting of a worker with a card    -> session_help
//   card.review_requested                      -> assess_draft at once (no debounce, no "already assessed" check)
//   maintenance.paused                         -> master.alert (maintenance_paused); .triggered is only logged
// The master's own write-back (suggested preset, plan version, evaluation event) does not
// restart the debounce: only owner fields count, and the content hash is the final arbiter.
// Accepting one of the master's proposals edits owner fields too, but that content is the master's
// own suggestion: it does not restart the debounce and is recorded as already evaluated.

import { createEventConsumer, type EventConsumer, type VibeDb, type VibeStore } from "../vibe/db";
import { isEvent, type ProposalEventBody } from "../vibe/contract";
import { contentHash, lastAssessmentMarker } from "../assess/assess";
import type { Clock } from "../clock";
import { defaultTuning, type TuningSource } from "../tuning";
import type { WakeJob } from "../types";
import { createDebouncer, type Debouncer } from "./debounce";
import type { WakeQueue } from "./queue";

/** card.updated field names (camelCase keys of the update, or DB columns) that change what the owner asked for. */
const OWNER_FIELDS = new Set(["title", "description", "acceptance", "refImages", "ref_images_json", "tags"]);
/** Fields a proposal can change, and how far apart acceptance and its card.updated may be. */
const PROPOSAL_FIELDS = ["title", "description", "acceptance"] as const;
const SWEEP_DRAFTS = 10;

/** Owner switches (settings). Review requests from the board ignore them: asking is explicit. */
export interface TriggerFlags {
  autoAssessOnCreate: boolean;
  autoAssessOnEdit: boolean;
  autoAssessOnMoveToDraft: boolean;
  wakeOnSessionWaiting: boolean;
  consolidateOnDone: boolean;
  sweepDraftLimit: number;
}

export const DEFAULT_TRIGGER_FLAGS: TriggerFlags = {
  autoAssessOnCreate: true,
  autoAssessOnEdit: true,
  autoAssessOnMoveToDraft: true,
  wakeOnSessionWaiting: true,
  consolidateOnDone: true,
  sweepDraftLimit: SWEEP_DRAFTS,
};

export interface TriggersOptions {
  db: VibeDb;
  store: VibeStore;
  clock: Clock;
  queue: WakeQueue;
  enabled(): boolean;
  debounceMs(): number;
  /** Automation parameters (settings); defaults when omitted. */
  tuning?: TuningSource;
  /** Read on every event; missing = everything on. */
  flags?(): TriggerFlags;
  pollIntervalMs?: number;
  /** vibe-scheduler signals: quota getting low / admission paused or resumed (memory). */
  onScheduler?(event: SchedulerSignal): void;
  /** vibe-maintain: a rule was paused after repeated rejections (the owner is reminded). */
  onMaintenancePaused?(event: { ruleName: string; rejections: number }): void;
  log?: (message: string, error?: unknown) => void;
}

export type SchedulerSignal =
  | { kind: "quota_low"; provider: string; level: "tight" | "exhausted"; remainingPct: number | null }
  | { kind: "paused" | "resumed" };

export interface Triggers {
  consumer: EventConsumer;
  debouncer: Debouncer<string>;
  /** Assess now (manual wake): cancels a pending debounce. */
  assessNow(cardId: string, force?: boolean): void;
  /** Queue drafts without an up-to-date assessment and recently finished cards without a memory update. */
  sweep(): number;
  stop(): Promise<void>;
}

export function createTriggers(options: TriggersOptions): Triggers {
  const { store, queue } = options;
  const log = options.log ?? (() => undefined);
  const flags = () => options.flags?.() ?? DEFAULT_TRIGGER_FLAGS;

  const debouncer = createDebouncer<string>(options.clock, options.debounceMs, (cardId) => {
    if (options.enabled()) queue.enqueue({ kind: "assess_draft", cardId });
  });

  function isDraft(cardId: string): boolean {
    const card = store.cards.get(cardId);
    return !!card && card.column === "draft" && !card.archivedAt;
  }

  /**
   * Is this edit just the newest accepted proposal being applied? True when every owner field of the
   * event is covered by that proposal's changes, the card still holds exactly those values and the
   * acceptance happened within seconds of the event. Records the content as evaluated (once per proposal).
   */
  function appliedProposal(cardId: string, fields: string[], eventTs: string): boolean {
    const card = store.cards.get(cardId);
    if (!card) return false;
    const owner = fields.filter((f) => OWNER_FIELDS.has(f));
    const events = store.events.list(cardId);
    let latest: { id: string; changes: Record<string, string | undefined>; resolvedAt: string } | null = null;
    for (const e of events) {
      const body = e.type === "proposal" ? (e.body as ProposalEventBody | null) : null;
      if (body?.status !== "accepted" || !body.resolvedAt) continue;
      if (!latest || body.resolvedAt >= latest.resolvedAt) {
        latest = { id: e.id, changes: body.changes, resolvedAt: body.resolvedAt };
      }
    }
    if (!latest || owner.length === 0) return false;
    const gap = Math.abs(Date.parse(latest.resolvedAt) - Date.parse(eventTs));
    if (!(gap <= (options.tuning ?? defaultTuning)().proposalWindowMs)) return false;
    const { id: proposalId, changes } = latest;
    const covered = owner.every((f) => {
      const field = PROPOSAL_FIELDS.find((x) => x === f);
      return !!field && changes[field] !== undefined && card[field] === changes[field];
    });
    if (!covered) return false;
    if (!events.some((e) => e.type === "status" && (e.body as { proposalId?: string } | null)?.proposalId === proposalId)) {
      const names = card.tags
        .map((id) => store.tags.list().find((t) => t.id === id)?.name)
        .filter((n): n is string => !!n);
      store.events.add({
        cardId,
        type: "status",
        authorKind: "system",
        author: "master",
        body: {
          kind: "proposal_applied",
          contentHash: contentHash(card, names),
          proposalId,
          text: "The accepted proposal was applied; this content counts as reviewed.",
        },
      });
    }
    return true;
  }

  const consumer = createEventConsumer({
    db: options.db,
    consumer: "vibe-master",
    types: [
      "card.created",
      "card.updated",
      "card.moved",
      "card.review_requested",
      "session.waiting",
      "scheduler.quota_low",
      "scheduler.paused",
      "scheduler.resumed",
      "maintenance.paused",
      "maintenance.triggered",
    ],
    startAt: "now",
    pollIntervalMs: options.pollIntervalMs,
    onError: (error, seq) => log(`event ${seq} failed`, error),
    handler: (event) => {
      if (isEvent(event, "scheduler.quota_low")) {
        const { provider, level, remainingPct } = event.payload;
        options.onScheduler?.({ kind: "quota_low", provider, level, remainingPct });
        return;
      }
      if (isEvent(event, "scheduler.paused")) return options.onScheduler?.({ kind: "paused" });
      if (isEvent(event, "scheduler.resumed")) return options.onScheduler?.({ kind: "resumed" });
      if (isEvent(event, "maintenance.paused")) {
        const { ruleName, rejections } = event.payload;
        return options.onMaintenancePaused?.({ ruleName, rejections });
      }
      // The draft a maintenance run creates is assessed through card.created like any other draft.
      if (isEvent(event, "maintenance.triggered")) {
        return log(`maintenance rule ${event.payload.ruleId} triggered (run ${event.payload.runId})`);
      }
      if (!options.enabled()) return;
      const cardId = event.cardId;
      const f = flags();
      if (isEvent(event, "card.review_requested")) {
        const id = event.payload.cardId || cardId;
        if (id && isDraft(id)) {
          debouncer.cancel(id);
          queue.enqueue({ kind: "assess_draft", cardId: id, force: true });
        }
      } else if (isEvent(event, "card.created")) {
        if (f.autoAssessOnCreate && cardId && event.payload.column === "draft") debouncer.touch(cardId);
      } else if (isEvent(event, "card.updated")) {
        if (
          cardId &&
          event.payload.fields.some((field) => OWNER_FIELDS.has(field)) &&
          isDraft(cardId) &&
          !appliedProposal(cardId, event.payload.fields, event.ts) &&
          f.autoAssessOnEdit
        ) {
          debouncer.touch(cardId);
        }
      } else if (isEvent(event, "card.moved")) {
        if (!cardId) return;
        if (event.payload.to === "draft") {
          if (f.autoAssessOnMoveToDraft) debouncer.touch(cardId);
        } else {
          debouncer.cancel(cardId);
          if (event.payload.to === "done" && f.consolidateOnDone) queue.enqueue({ kind: "card_done", cardId });
        }
      } else if (isEvent(event, "session.waiting")) {
        if (!f.wakeOnSessionWaiting) return;
        const session = store.sessions.get(event.payload.sessionId);
        if (session && session.role === "worker" && session.cardId) {
          const job: WakeJob = {
            kind: "session_help",
            cardId: session.cardId,
            sessionId: session.id,
            question: event.payload.question,
          };
          queue.enqueue(job);
        }
      }
    },
  });
  consumer.start();

  return {
    consumer,
    debouncer,

    assessNow(cardId, force = true) {
      debouncer.cancel(cardId);
      queue.enqueue({ kind: "assess_draft", cardId, force });
    },

    sweep() {
      let queued = 0;
      const drafts = store.cards
        .list({ column: "draft" })
        .filter((card) => {
          const names = card.tags
            .map((id) => store.tags.list().find((t) => t.id === id)?.name)
            .filter((n): n is string => !!n);
          return lastAssessmentMarker(store.events.list(card.id))?.hash !== contentHash(card, names);
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, flags().sweepDraftLimit);
      for (const card of drafts) {
        queue.enqueue({ kind: "assess_draft", cardId: card.id });
        queued++;
      }
      const since = new Date(options.clock.now() - (options.tuning ?? defaultTuning)().sweepDoneWindowMs).toISOString();
      for (const card of flags().consolidateOnDone ? store.cards.list({ column: "done" }) : []) {
        if (card.updatedAt < since) continue;
        const consolidated = store.events
          .list(card.id)
          .some((e) => (e.body as { kind?: string } | null)?.kind === "memory_update");
        if (!consolidated) {
          queue.enqueue({ kind: "card_done", cardId: card.id });
          queued++;
        }
      }
      return queued;
    },

    async stop() {
      debouncer.dispose();
      await consumer.stop();
    },
  };
}
