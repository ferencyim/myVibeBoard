import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { computeOverview } from "../server/aggregate";
import { createIndexer } from "../server/indexer";
import { buildSessionMap } from "../server/session-map";
import { createUsageCommands, createVibeStore } from "../server/vibe/db";
import { claudeLine, lines, openTestDb, rootsFor, tempDir, write } from "./helpers";

const event = {
  ts: "2026-10-01T12:00:00Z",
  model: "unknown",
  tokensIn: 100,
  tokensOut: 10,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  durationMs: null,
  cost: null,
};

describe("任务用量归因", () => {
  it("按提供方隔离相同会话 ID，历史记录无卡片仍可按项目、模型和日期查看", () => {
    const db = openTestDb();
    const store = createVibeStore(db);
    const project = store.projects.create({
      name: "历史项目",
      prefix: "OLD",
      repoPath: "<history>",
      projectType: "web",
    });
    const usage = createUsageCommands(db);
    usage.putEvent({ ...event, provider: "claude", sessionId: "same", dedupeKey: "historical" });
    usage.putEvent({ ...event, provider: "codex", sessionId: "same", dedupeKey: "native" });
    usage.relink([
      {
        provider: "claude",
        sessionId: "same",
        projectId: project.id,
        workspaceId: null,
        role: null,
        agentId: null,
      },
      {
        provider: "codex",
        sessionId: "same",
        projectId: project.id,
        workspaceId: "workspace",
        role: "verifier",
        agentId: "agent",
      },
    ]);
    db.exec("ALTER TABLE card RENAME TO retired_card");
    const overview = computeOverview(db, "all");
    expect(overview.totals).toMatchObject({ events: 2, unpricedTokens: 220, cost: 0 });
    expect(overview.byProject).toEqual([
      expect.objectContaining({ key: project.id, label: "历史项目", events: 2 }),
    ]);
    expect(overview.byModel).toHaveLength(2);
    expect(overview.byDay).toHaveLength(1);
    expect(overview.byRole).toContainEqual(expect.objectContaining({ key: "verifier", events: 1 }));
    expect(overview.tasks).toEqual([
      expect.objectContaining({ workspaceId: "workspace", tokens: 110 }),
    ]);
    expect(store.tasks.list()).toHaveLength(0);
    db.close();
  });

  it("接续及索引重启、重放后不会把旧用量计入两次", async () => {
    const db = openTestDb();
    const base = tempDir();
    const first = claudeLine("2026-10-01T12:00:00Z", "old", "r1", [100, 10, 0, 0]);
    const second = {
      ...claudeLine("2026-10-01T12:01:00Z", "new", "r2", [200, 20, 0, 0]),
      sessionId: "continuation",
    };
    write(join(base, "claude", "projects", "p", "first.jsonl"), lines(first));
    write(join(base, "claude", "projects", "p", "next.jsonl"), lines(first, second));
    let indexer = createIndexer({ db, roots: () => rootsFor(base) });
    await indexer.scan();
    const links = ["sess-claude-1", "continuation"].map((sessionId) => ({
      provider: "claude",
      sessionId,
      projectId: "p",
      workspaceId: "workspace",
      role: "worker",
      agentId: sessionId,
    }));
    indexer.relink(links);
    indexer = createIndexer({ db, roots: () => rootsFor(base) });
    indexer.resetCursors();
    await indexer.scan();
    expect(indexer.relink(links)).toBe(0);
    const overview = computeOverview(db, "all");
    expect(overview.totals).toMatchObject({ input: 300, output: 30, events: 2 });
    expect(overview.byWorkspace).toEqual([
      expect.objectContaining({ key: "workspace", events: 2 }),
    ]);
    expect(overview.byRole).toEqual([expect.objectContaining({ key: "worker", events: 2 })]);
    db.close();
  });

  it("原生同一会话重新挂接不会重复链接，跨任务歧义不猜归属", async () => {
    const agents = ["a", "b", "c"].map((id) => ({
      agent: { id, persistence: { provider: "claude", sessionId: "same" } },
    }));
    const paseo = {
      agents: { list: async () => ({ entries: agents, pageInfo: { hasMore: false } }) },
    };
    const store = {
      sessions: {
        getByAgent: (id: string) => ({
          workspaceId: id === "c" ? "other" : "workspace",
          projectId: "project",
          role: "worker",
          currentProvider: "claude",
        }),
      },
      projectConfigs: { get: () => undefined },
    };
    expect(await buildSessionMap(paseo as never, store)).toEqual([]);
    agents.pop();
    expect(await buildSessionMap(paseo as never, store)).toEqual([
      expect.objectContaining({ sessionId: "same", workspaceId: "workspace" }),
    ]);
  });
  it("总 agent 没有 workspace 时仍按项目和角色归因，不制造任务", async () => {
    const paseo = {
      agents: {
        list: async () => ({
          entries: [
            {
              agent: {
                id: "master",
                persistence: { provider: "claude", sessionId: "master-session" },
              },
            },
          ],
          pageInfo: { hasMore: false },
        }),
      },
    };
    const store = {
      sessions: {
        getByAgent: () => ({
          workspaceId: null,
          projectId: "native-project",
          role: "master",
          currentProvider: "claude",
        }),
      },
      projectConfigs: { get: () => ({ id: "project" }) },
    };
    expect(await buildSessionMap(paseo as never, store)).toEqual([
      {
        provider: "claude",
        sessionId: "master-session",
        workspaceId: null,
        projectId: "project",
        role: "master",
        agentId: "master",
      },
    ]);
  });
});
