import { describe, expect, it, vi } from "vitest";
import { startAdmissionConsumer } from "../server/dispatch/admission";
import { BoardError } from "../server/service";
import { publishEvent } from "../server/vibe/db";
import { setupBoard } from "./helpers";

function setup(dispatch: (id: string, opts?: unknown) => Promise<unknown>) {
  const { board, runtime } = setupBoard();
  const { project } = board.projects.create({ name: "Demo", prefix: "DEMO", repoPath: "/r", projectType: "web" });
  const { card } = board.cards.create({ project: project.prefix, title: "t", column: "todo" });
  const consumer = startAdmissionConsumer({ db: runtime.db, board, dispatcher: { dispatch: dispatch as never } });
  const admit = (extra: Record<string, unknown> = {}) =>
    publishEvent(runtime.db, { type: "scheduler.admitted", cardId: card.id, payload: { cardId: card.id, ...extra } });
  const failed = () =>
    runtime.db.prepare<{ payload_json: string }>("SELECT payload_json FROM vibe_event WHERE type = 'scheduler.dispatch_failed'").all();
  return { board, card, consumer, admit, failed };
}

describe("scheduler admission consumer", () => {
  it("dispatches an admitted todo card with the scheduler's preset and port", async () => {
    const dispatch = vi.fn(async () => ({}));
    const t = setup(dispatch);
    t.admit({ presetId: "p1", port: 3105 });
    await t.consumer.poll();
    await t.consumer.stop();
    expect(dispatch).toHaveBeenCalledWith(
      t.card.id,
      expect.objectContaining({ presetId: "p1", force: true, extraInstructions: expect.stringContaining("3105") }),
    );
  });

  it("ignores cards that already left todo (replay / manual dispatch)", async () => {
    const dispatch = vi.fn(async () => ({}));
    const t = setup(dispatch);
    t.board.cards.move(t.card.id, { to: "draft" });
    t.admit();
    await t.consumer.poll();
    await t.consumer.stop();
    expect(dispatch).not.toHaveBeenCalled();
    expect(t.failed()).toHaveLength(0);
  });

  it("reports a failure to the scheduler and leaves a card event", async () => {
    const t = setup(async () => {
      throw new BoardError("unavailable", "no daemon connection");
    });
    t.admit();
    await t.consumer.poll();
    await t.consumer.stop();
    expect(t.failed().map((r) => JSON.parse(r.payload_json))).toEqual([
      { cardId: t.card.id, message: expect.stringContaining("no daemon connection") },
    ]);
    expect(JSON.stringify(t.board.store.events.list(t.card.id))).toContain("admission_failed");
  });
});
