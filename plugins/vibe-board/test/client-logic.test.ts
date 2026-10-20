import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cardsFingerprint,
  columnAtX,
  errorMessage,
  evidenceDefault,
  filterCards,
  groupByColumn,
  insertIndexAtY,
  planDrop,
  projectColor,
  resolvePresetChoice,
  stepNeighbours,
  userTargets,
} from "../client/board/logic";
import {
  draftToPayload,
  presetToDraft,
  quotaFor,
  validateDraft,
  type ProviderUsageLike,
} from "../client/presets/logic";
import { DEFAULT_TAGS, type CardView, type Preset } from "../shared/vibe/contract";
import { presetsCreateRpc, presetsUpdateRpc } from "../shared/rpc";
import { setupBoard } from "./helpers";

function card(over: Partial<CardView> & { id: string }): CardView {
  return {
    projectId: "p1",
    number: 1,
    key: over.id.toUpperCase(),
    title: over.id,
    description: "",
    column: "todo",
    sortKey: over.id,
    priority: "none",
    acceptance: "",
    refImages: [],
    needsEvidence: false,
    presetId: null,
    suggestedPresetId: null,
    worktree: null,
    origin: "manual",
    originRef: null,
    dedupeKey: null,
    planSessionId: null,
    parentCardId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    updatedHlc: "",
    tags: [],
    ...over,
  };
}

describe("filter / group", () => {
  const cards = [
    card({ id: "a", projectId: "p1", title: "Login page", priority: "high", tags: ["tag_bug"] }),
    card({ id: "b", projectId: "p2", title: "Dark mode", description: "theme", column: "draft" }),
    card({ id: "c", projectId: "p1", title: "Docs", column: "done", sortKey: "0" }),
  ];

  it("filters by project, priority, tag and text", () => {
    expect(filterCards(cards, {}).length).toBe(3);
    expect(filterCards(cards, { projectId: "p1" }).map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterCards(cards, { priority: "high" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterCards(cards, { tagId: "tag_bug" }).map((c) => c.id)).toEqual(["a"]);
    expect(filterCards(cards, { search: " THEME " }).map((c) => c.id)).toEqual(["b"]);
    expect(filterCards(cards, { projectId: "p1", search: "dark" })).toEqual([]);
  });

  it("groups into the five columns ordered by sortKey", () => {
    const grouped = groupByColumn([
      card({ id: "z", sortKey: "b" }),
      card({ id: "y", sortKey: "a" }),
      card({ id: "x", column: "verifying" }),
    ]);
    expect(Object.keys(grouped)).toEqual(["draft", "todo", "in_progress", "verifying", "done"]);
    expect(grouped.todo.map((c) => c.id)).toEqual(["y", "z"]);
    expect(grouped.verifying).toHaveLength(1);
  });

  it("fingerprint changes only when something visible changes", () => {
    const base = [card({ id: "a" })];
    expect(cardsFingerprint(base)).toBe(cardsFingerprint([card({ id: "a" })]));
    expect(cardsFingerprint(base)).not.toBe(cardsFingerprint([card({ id: "a", column: "draft" })]));
    expect(cardsFingerprint(base)).not.toBe(cardsFingerprint([card({ id: "a", updatedHlc: "x" })]));
  });

  it("colors projects with their hex or a stable palette entry", () => {
    expect(projectColor({ color: "#112233" }, 0)).toBe("#112233");
    expect(projectColor({ color: null }, 0)).toBe(projectColor({ color: "blue" }, 8));
    expect(projectColor({ color: null }, -1)).toMatch(/^#/);
  });

  it("strips the server error code", () => {
    expect(errorMessage(new Error("[illegal_transition] nope"))).toBe("nope");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("evidence default and preset choice", () => {
  const tags = DEFAULT_TAGS.map((t) => ({ ...t, builtin: true, updatedHlc: "" }));
  it("is on for feature/change, off for bug/doc", () => {
    expect(evidenceDefault(["tag_feature"], tags)).toBe(true);
    expect(evidenceDefault(["tag_change", "tag_bug"], tags)).toBe(true);
    expect(evidenceDefault(["tag_bug", "tag_doc"], tags)).toBe(false);
    expect(evidenceDefault([], tags)).toBe(false);
  });

  const preset = (id: string): Preset => ({
    id,
    name: id,
    provider: "claude",
    model: "m",
    thinking: "",
    permissionMode: "auto",
    environmentKind: "new-worktree",
    baseBranch: null,
    runtimeEnv: null,
    instructions: "",
    builtin: false,
    createdAt: "",
    updatedAt: "",
    updatedHlc: "",
  });
  it("adopts the recommendation unless the user chose, and flags conflicts", () => {
    const presets = [preset("a"), preset("b")];
    expect(resolvePresetChoice({ presetId: null, suggestedPresetId: "b" }, presets)).toMatchObject({
      effectiveId: "b",
      conflict: false,
    });
    expect(resolvePresetChoice({ presetId: "a", suggestedPresetId: "b" }, presets)).toMatchObject({
      effectiveId: "a",
      conflict: true,
    });
    expect(resolvePresetChoice({ presetId: "a", suggestedPresetId: "a" }, presets).conflict).toBe(false);
    expect(resolvePresetChoice({ presetId: null, suggestedPresetId: null }, presets).effectiveId).toBeNull();
  });
});

describe("drag targets", () => {
  const rect = (x: number, y: number, w = 100, h = 40) => ({ x, y, width: w, height: h });

  it("finds the column under the pointer and the insert index", () => {
    const cols = [
      { column: "draft" as const, rect: rect(0, 0, 100, 10) },
      { column: "todo" as const, rect: rect(110, 0, 100, 10) },
    ];
    expect(columnAtX(50, cols)).toBe("draft");
    expect(columnAtX(150, cols)).toBe("todo");
    expect(columnAtX(500, cols)).toBeNull();
    const items = [rect(0, 0), rect(0, 50)];
    expect(insertIndexAtY(5, items)).toBe(0);
    expect(insertIndexAtY(30, items)).toBe(1);
    expect(insertIndexAtY(200, items)).toBe(2);
  });

  it("allows only state-machine moves for the user", () => {
    expect(userTargets("draft")).toEqual(["todo"]);
    expect(userTargets("todo")).toEqual(["draft"]);
    expect(userTargets("in_progress")).toEqual([]);
    expect(userTargets("verifying")).toEqual(["in_progress", "done"]);
    expect(userTargets("done")).toEqual([]);
  });

  it("plans moves, reorders and refusals", () => {
    const todo = [{ id: "t1" }, { id: "t2" }];
    const c = { id: "d1", column: "draft" as const };
    expect(planDrop(c, "todo", 2, todo)).toEqual({ type: "move", to: "todo", place: null });
    expect(planDrop(c, "todo", 1, todo)).toEqual({
      type: "move",
      to: "todo",
      place: { afterCard: "t1", beforeCard: "t2" },
    });
    expect(planDrop(c, "done", 0, [])).toMatchObject({ type: "illegal" });
    expect(planDrop({ id: "p", column: "in_progress" }, "todo", 0, todo)).toMatchObject({
      type: "illegal",
    });
    const own = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(planDrop({ id: "a", column: "todo" }, "todo", 0, own)).toEqual({ type: "none" });
    expect(planDrop({ id: "a", column: "todo" }, "todo", 2, own)).toEqual({
      type: "reorder",
      afterCard: "c",
      beforeCard: null,
    });
    expect(planDrop({ id: "c", column: "todo" }, "todo", 0, own)).toEqual({
      type: "reorder",
      afterCard: null,
      beforeCard: "a",
    });
  });

  it("computes menu reorder steps", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(stepNeighbours(list, "a", "up")).toBeNull();
    expect(stepNeighbours(list, "a", "top")).toBeNull();
    expect(stepNeighbours(list, "a", "down")).toEqual({ afterCard: "b", beforeCard: "c" });
    expect(stepNeighbours(list, "c", "top")).toEqual({ afterCard: null, beforeCard: "a" });
    expect(stepNeighbours(list, "b", "bottom")).toEqual({ afterCard: "c", beforeCard: null });
    expect(stepNeighbours(list, "zz", "up")).toBeNull();
  });
});

describe("quota display (providers.listUsage)", () => {
  const usage: ProviderUsageLike[] = [
    {
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      windows: [
        { id: "5h", label: "5 hours", shortLabel: "5h", remainingPct: 73 },
        { id: "wk", label: "Week", shortLabel: "wk", usedPct: 95 },
      ],
    },
    { providerId: "codex", displayName: "Codex", status: "error", windows: [] },
    { providerId: "x", displayName: "X", status: "available", windows: [{ id: "a", label: "a" }] },
  ];
  it("shows the tightest window with a tone", () => {
    expect(quotaFor("claude", usage)).toEqual({ text: "wk 5%", remainingPct: 5, tone: "danger" });
    expect(quotaFor("codex", usage)).toBeNull();
    expect(quotaFor("x", usage)).toBeNull();
    expect(quotaFor("missing", usage)).toBeNull();
    expect(quotaFor("claude", null)).toBeNull();
    expect(
      quotaFor("claude", [{ ...usage[0]!, windows: [{ id: "a", label: "A", remainingPct: 50 }] }]),
    ).toEqual({ text: "A 50%", remainingPct: 50, tone: "ok" });
  });
});

describe("preset persistence round trip", () => {
  it("draft -> create RPC -> list -> draft is lossless", () => {
    const { board } = setupBoard();
    const draft = {
      name: "Fast",
      provider: "claude",
      model: "sonnet",
      thinking: "low",
      permissionMode: "auto" as const,
      environmentKind: "project-default" as const,
      baseBranch: "main",
      runtimeEnv: "",
      instructions: "be brief",
      fallbackPresetIds: [] as string[],
      roleHint: "scout",
    };
    expect(validateDraft(draft)).toBeNull();
    expect(validateDraft({ ...draft, model: " " })).not.toBeNull();
    const { preset } = board.presets.create(draftToPayload(draft));
    const listed = board.presets.list().presets.find((p) => p.id === preset.id)!;
    expect(presetToDraft(listed)).toEqual(draft);
    const updated = board.presets.update(preset.id, draftToPayload({ ...draft, baseBranch: "" }));
    expect(updated.preset.baseBranch).toBeNull();
    expect(updated.preset.roleHint).toBe("scout");
    expect(listed.roleHint).toBe("scout");
    const cleared = board.presets.update(preset.id, draftToPayload({ ...draft, roleHint: "" }));
    expect(cleared.preset.roleHint).toBeNull();
  });

  it("presets RPCs accept roleHint and reject unknown purposes and a blank model", () => {
    const base = { name: "P", provider: "claude", model: "sonnet" };
    for (const roleHint of ["worker", "scout", "reviewer", null]) {
      expect(presetsCreateRpc.input.safeParse({ ...base, roleHint }).success).toBe(true);
      expect(presetsUpdateRpc.input.safeParse({ presetId: "x", roleHint }).success).toBe(true);
    }
    expect(presetsCreateRpc.input.safeParse({ ...base, roleHint: "boss" }).success).toBe(false);
    expect(presetsCreateRpc.input.safeParse({ ...base, model: "  " }).success).toBe(false);
    expect(presetsUpdateRpc.input.safeParse({ presetId: "x", model: "" }).success).toBe(false);
  });
});

describe("legacy Tasks UI is gone", () => {
  it("has no tasks.* RPC names in client sources", () => {
    const root = join(__dirname, "..");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of [...files(join(root, "client")), join(root, "index.client.tsx")]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/tasks\./);
    }
  });
});
