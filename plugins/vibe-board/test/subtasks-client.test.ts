// WP-106 client logic: subtask editing, the execution tab's subtask list and chat targets, and the
// collapsed timeline.

import { describe, expect, it } from "vitest";
import { timelineSummary, toggleExpanded } from "../client/detail/events";
import { chatItemsOf, chatTargets, proposalDiff } from "../client/planning/logic";
import {
  editError,
  newSubtask,
  removeSubtask,
  splitList,
  subtaskRows,
  toggleDependency,
} from "../client/planning/subtask-logic";
import type { CardEvent, Preset, Subtask, SubtaskRun } from "../shared/vibe/contract";

const st = (id: string, over: Partial<Subtask> = {}): Subtask => ({
  id,
  title: `任务${id}`,
  goal: "",
  method: "",
  notes: "",
  acceptance: "",
  files: [],
  dependsOn: [],
  presetId: null,
  ...over,
});
const run = (status: SubtaskRun["status"], over: Partial<SubtaskRun> = {}): SubtaskRun => ({
  status,
  sessionId: null,
  agentId: null,
  presetId: null,
  summary: "",
  error: "",
  attempts: 0,
  notified: true,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const preset = (id: string, name: string) => ({ id, name, provider: "claude", model: "m" }) as Preset;
const plan = (subtasks: Subtask[]) => ({ description: "p", checks: [], subCards: [], tags: [], recommendedPresetId: null, subtasks });
const ev = (over: Partial<CardEvent>): CardEvent => ({
  id: "e1",
  cardId: "c",
  type: "chat",
  authorKind: "executor",
  author: "",
  body: { text: "x", thread: "exec" },
  createdAt: "2026-10-22T08:30:15.000Z",
  updatedHlc: "",
  ...over,
});

describe("subtask editing", () => {
  it("adds with a free id, removes with its dependencies, toggles dependencies", () => {
    const list = [st("s1"), st("s3", { dependsOn: ["s1"] })];
    expect(newSubtask(list).id).toBe("s4");
    expect(newSubtask([]).id).toBe("s1");
    expect(removeSubtask(list, "s1")).toEqual([st("s3")]);
    expect(toggleDependency(list, "s3", "s1")[1]!.dependsOn).toEqual([]);
    expect(toggleDependency([st("s1"), st("s2")], "s2", "s1")[1]!.dependsOn).toEqual(["s1"]);
  });

  it("parses file lists and refuses blank titles and cycles", () => {
    expect(splitList("src/a.ts, src/b/**\n docs/x.md，")).toEqual(["src/a.ts", "src/b/**", "docs/x.md"]);
    expect(editError([st("s1", { title: " " })])).toContain("需要标题");
    expect(editError([st("s1", { dependsOn: ["s2"] }), st("s2", { dependsOn: ["s1"] })])).toContain("成环");
    expect(editError([st("s1"), st("s2", { dependsOn: ["s1"] })])).toBeNull();
  });
});

describe("execution tab", () => {
  const presets = [preset("main", "主力"), preset("cheap", "便宜"), preset("big", "大模型")];
  const card = {
    plan: plan([st("s1"), st("s2", { presetId: "big" }), st("s3", { presetId: "big", dependsOn: ["s1"] })]),
    subtaskRuns: {
      s1: run("done", { presetId: "cheap", summary: "做完了", agentId: "a1", sessionId: "x1" }),
      s2: run("running", { presetId: "cheap", agentId: "a2", sessionId: "x2" }),
    },
    subagentPresetId: "cheap",
    presetId: "main",
  };

  it("lists status, model and the sub-agent session of each subtask", () => {
    const rows = subtaskRows(card, presets);
    expect(rows.map((r) => [r.id, r.statusLabel, r.model])).toEqual([
      ["s1", "完成", "便宜"],
      ["s2", "进行中", "便宜"],
      ["s3", "待开始", "大模型"],
    ]);
    expect(rows[0]).toMatchObject({ note: "做完了", agentId: "a1" });
    // s2 was given another model while its sub-agent runs: said, not applied to the running one.
    expect(rows[1]!.modelChanged).toBe(true);
    expect(subtaskRows({ ...card, subagentPresetId: null }, presets)[0]!.model).toBe("便宜");
    expect(subtaskRows({ ...card, subtaskRuns: {}, subagentPresetId: null }, presets)[0]!.model).toBe("主力（默认）");
  });

  it("the owner can talk to the main agent or to any subtask that has a sub-agent", () => {
    expect(chatTargets(card).map((t) => [t.subtask, t.label])).toEqual([
      [null, "主代理"],
      ["s1", "子代理 s1 · 任务s1"],
      ["s2", "子代理 s2 · 任务s2"],
    ]);
  });

  it("labels sub-agent lines and owner messages sent to a sub-agent", () => {
    const items = chatItemsOf(
      [
        ev({ id: "a", body: { text: "完成", thread: "exec", subtask: "s1" } }),
        ev({ id: "b", body: { text: "主代理的小结", thread: "exec" } }),
        ev({ id: "c", authorKind: "user", body: { text: "加注释", thread: "exec", subtask: "s1" } }),
        ev({ id: "d", authorKind: "system", body: { text: "已启动子代理", thread: "exec", subtask: "s1", agentId: "a1" } }),
      ],
      "exec",
    );
    expect(items.map((i) => (i.kind === "message" ? i.label : i.kind))).toEqual(["子代理 s1", "主代理", "你 → 子代理 s1", "system"]);
    expect(items[3]).toMatchObject({ kind: "system", subtask: "s1", agentId: "a1" });
  });

  it("shows a subtask proposal as before / after", () => {
    const diffs = proposalDiff(
      { status: "pending", changes: { subtasks: [st("s1", { dependsOn: [] }), st("s2", { dependsOn: ["s1"], presetId: "big" })] } },
      { title: "t", description: "", acceptance: "", plan: plan([st("s1")]) },
      presets,
    );
    expect(diffs).toEqual([
      { field: "subtasks", label: "子任务", before: "s1 · 任务s1", after: "s1 · 任务s1\ns2 · 任务s2（依赖 s1；模型 大模型）" },
    ]);
  });
});

describe("timeline", () => {
  it("collapses every event to time, type and a short title; a tap toggles it", () => {
    const long = "第一行很长".repeat(20);
    const line = timelineSummary(ev({ type: "note", authorKind: "user", body: { text: `${long}\n第二行` } }));
    expect(line.time).toBe("10-22 08:30");
    expect(line.type).toBe("备注");
    expect(line.title.length).toBe(60);
    expect(line.more).toBe(true);
    const short = timelineSummary(ev({ type: "status", authorKind: "system", body: { kind: "moved", from: "todo", to: "in_progress" } }));
    expect(short.more).toBe(false);
    expect(short.title).toContain("→");
    const open = toggleExpanded(new Set(), "e1");
    expect(open.has("e1")).toBe(true);
    expect(toggleExpanded(open, "e1").has("e1")).toBe(false);
  });
});
