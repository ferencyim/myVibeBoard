import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformAssistantTaskDirectives } from "../shared/directive";
import { startTasksBridge } from "../server/bridge";
import { runTasksCli } from "../server/cli-runner";
import {
  createApiStore,
  createDomainHandlers,
  transitionTrackedThread,
  type TasksApiStore,
  type TasksDomain,
} from "../server/domain";
import { openTasksDatabase } from "../server/sqlite";
import { TasksPageCursorError } from "../server/store";

describe("paseo-plugin-tasks", () => {
  let tempDir: string;
  let store: TasksApiStore;
  let domain: TasksDomain;
  const sentPrompts: Array<{ agentId: string; text: string }> = [];
  const createdWorkspaces: Array<{ title?: string; source: unknown }> = [];
  const createdAgents: Array<{
    title?: string;
    prompt?: string;
    labels?: Record<string, string>;
    config: unknown;
  }> = [];

  const mockPaseo = {
    projects: {
      list: vi.fn(async () => ({
        requestId: "req_1",
        projects: [
          {
            projectId: "prj_demo123",
            projectDisplayName: "Demo Repo",
            projectRootPath: "/tmp/demo-repo",
            projectKind: "git" as const,
          },
        ],
      })),
    },
    workspaces: {
      create: vi.fn(async (opts: { title?: string; source: unknown }) => {
        createdWorkspaces.push(opts);
        return {
          id: "wks_spawned_1",
          projectId: "prj_demo123",
          directory: "/tmp/demo-repo-wt",
          name: "wt-1",
          status: "running" as const,
          agents: {
            create: vi.fn(async (agentOpts: {
              title?: string;
              prompt?: string;
              labels?: Record<string, string>;
              config: unknown;
            }) => {
              createdAgents.push(agentOpts);
              return {
                id: "agent-uuid-1001",
                timeline: {
                  append: vi.fn(async () => ({ seq: 1, epoch: "e1" })),
                },
              };
            }),
          },
        };
      }),
    },
    agents: {
      list: vi.fn(async () => ({
        requestId: "req_agents",
        entries: [
          {
            agent: {
              id: "agent-uuid-1001",
              workspaceId: "wks_spawned_1",
              provider: "codex",
              status: "running",
              title: "PROD-1 · Ship task delegation",
              cwd: "/tmp/demo-repo-wt",
              archivedAt: null,
            },
          },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      })),
      ref: vi.fn((agentId: string) => ({
        id: agentId,
        refresh: vi.fn(async () => ({
          agent: {
            id: agentId,
            workspaceId: "wks_spawned_1",
            provider: "codex",
            status: "idle",
            title: "Worker Agent",
            cwd: "/tmp/demo-repo-wt",
            archivedAt: null,
          },
          project: null,
        })),
        send: vi.fn(async (text: string) => {
          sentPrompts.push({ agentId, text });
        }),
        timeline: {
          append: vi.fn(async () => ({ seq: 1, epoch: "e1" })),
        },
      })),
    },
    providers: {
      listAvailable: vi.fn(async () => ({
        requestId: "req_prov",
        providers: [{ provider: "codex", available: true, error: null }],
      })),
      listModels: vi.fn(async () => ({
        requestId: "req_models",
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
      })),
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "paseo-tasks-test-"));
    const db = openTasksDatabase(join(tempDir, "tasks.db"));
    store = createApiStore(db, tempDir);
    store.ensureDefaultPresets();
    domain = createDomainHandlers(store, () => mockPaseo as never);
    sentPrompts.length = 0;
    createdWorkspaces.length = 0;
    createdAgents.length = 0;
  });

  afterEach(async () => {
    store.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates folders, projects, labels, tasks, subtasks, moves across projects with key aliases, and enforces cursor revisions", () => {
    const folder = domain.createFolder({ name: "Engineering" }).folder;
    const prod = domain.createProject({
      name: "Product",
      prefix: "PROD",
      color: "blue",
      folderId: folder.id,
      linkedBbProjectId: "prj_demo123",
    }).project;
    const ops = domain.createProject({
      name: "Ops",
      prefix: "OPS",
      color: "orange",
    }).project;

    const label = domain.createLabel({
      projectId: prod.id,
      name: "Backend",
      color: "blue",
    }).label;

    const t1Res = domain.createTask({
      projectId: prod.id,
      title: "Ship task delegation",
      description: "Implement worktree delegation.",
      priority: "urgent",
      status: "todo",
      dueDate: "2026-10-30",
      labelIds: [label.id],
    });
    expect(t1Res.ok).toBe(true);
    if (!t1Res.ok) return;
    expect(t1Res.task.key).toBe("PROD-1");

    const subRes = domain.createTask({
      projectId: prod.id,
      title: "Add unit tests",
      parentTaskId: t1Res.task.id,
    });
    expect(subRes.ok).toBe(true);
    if (!subRes.ok) return;
    expect(subRes.task.key).toBe("PROD-2");

    // Cursor pagination check
    const page1 = domain.listTasks({ projectId: prod.id, limit: 1 });
    expect(page1.tasks).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();

    // Mutating task list invalidates old cursor
    domain.updateTask({
      taskId: t1Res.task.id,
      priority: "high",
    });
    expect(() =>
      domain.listTasks({
        projectId: prod.id,
        limit: 1,
        cursor: page1.nextCursor!,
      }),
    ).toThrow(TasksPageCursorError);

    // Move task + subtask to OPS and verify old PROD-1 alias still resolves
    const moved = domain.moveTaskToProject({
      taskId: t1Res.task.id,
      projectId: ops.id,
    });
    expect(moved.ok).toBe(true);
    expect(moved.task.key).toBe("OPS-1");
    expect(domain.getTaskByKey({ taskKey: "PROD-1" }).task?.id).toBe(
      t1Res.task.id,
    );
    expect(domain.getTaskByKey({ taskKey: "OPS-1" }).task?.id).toBe(
      t1Res.task.id,
    );
  });

  it("delegates a task to a Paseo worktree agent, tracks lifecycle transitions, and steers the agent on comment --notify", async () => {
    const prod = domain.createProject({
      name: "Product",
      prefix: "PROD",
      color: "blue",
      linkedBbProjectId: "prj_demo123",
    }).project;
    const taskRes = domain.createTask({
      projectId: prod.id,
      title: "Implement auth middleware",
      description: "Verify JWT claims.",
      status: "todo",
      priority: "high",
    });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const presets = domain.listPresets().presets;
    expect(presets.length).toBeGreaterThan(0);
    const worktreePreset = presets.find(
      (p) => p.environmentKind === "new-worktree",
    )!;

    const delegated = await domain.delegate({
      taskId: taskRes.task.id,
      presetId: worktreePreset.id,
      extraInstructions: "Focus on token expiry edge cases.",
    });

    expect(delegated.threadId).toBe("agent-uuid-1001");
    expect(delegated.workspaceId).toBe("wks_spawned_1");
    expect(createdWorkspaces).toHaveLength(1);
    expect(createdAgents).toHaveLength(1);
    expect(createdAgents[0]?.labels).toMatchObject({
      taskKey: "PROD-1",
      taskId: taskRes.task.id,
    });

    // Task automatically advanced to in_progress
    const updatedTask = domain.getTaskByKey({ taskKey: "PROD-1" }).task!;
    expect(updatedTask.status).toBe("in_progress");

    // Agent posts a milestone comment
    await domain.createComment({
      taskId: updatedTask.id,
      kind: "agent",
      authorName: "agent (agent-uuid-1001)",
      threadId: "agent-uuid-1001",
      body: "Implemented middleware; running test suite.",
      notify: false,
      awaitDelivery: true,
    });

    // User posts a follow-up comment with notify: true -> steers agent-uuid-1001
    const userComment = await domain.createComment({
      taskId: updatedTask.id,
      kind: "user",
      authorName: "You",
      body: "Also support leeway of 30 seconds.",
      notify: true,
      awaitDelivery: true,
    });
    expect(userComment.comment.notifiedCount).toBe(1);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]?.agentId).toBe("agent-uuid-1001");
    expect(sentPrompts[0]?.text).toContain("Also support leeway of 30 seconds.");

    // Lifecycle transition to completed writes a system comment
    transitionTrackedThread(store, "agent-uuid-1001", "completed");
    const threads = domain.listTaskThreads({ taskId: updatedTask.id }).taskThreads;
    expect(threads[0]?.liveStatus).toBe("completed");
    const comments = (await domain.listComments({ taskId: updatedTask.id })).comments;
    expect(
      comments.some((c) => c.kind === "system" && c.body.includes("completed")),
    ).toBe(true);
  });

  it("supports CLI commands and the local HTTP + MCP bridge", async () => {
    const seedRes = await runTasksCli(["seed-demo", "--yes", "--json"], store, domain);
    expect(seedRes.exitCode).toBe(0);
    const seeded = JSON.parse(seedRes.stdout) as { tasksCreated: number };
    expect(seeded.tasksCreated).toBe(12);

    const showRes = await runTasksCli(["show", "TASKS-1", "--json"], store, domain);
    expect(showRes.exitCode).toBe(0);
    const shown = JSON.parse(showRes.stdout) as { task: { key: string; title: string } };
    expect(shown.task.key).toBe("TASKS-1");

    // Test HTTP & MCP bridge
    const bridge = await startTasksBridge(store, domain);
    try {
      const mcpList = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      }).then((r) => r.json());
      expect(mcpList.result.tools.length).toBeGreaterThanOrEqual(8);

      const mcpCall = await fetch(`${bridge.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
          "x-paseo-agent-id": "agent-uuid-1001",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "tasks_update",
            arguments: {
              key: "TASKS-1",
              status: "in_review",
            },
          },
        }),
      }).then((r) => r.json());
      expect(mcpCall.result.isError).toBe(false);
      expect(domain.getTaskByKey({ taskKey: "TASKS-1" }).task?.status).toBe(
        "in_review",
      );
    } finally {
      await bridge.close();
    }
  });

  it("transforms ::task{key=...} directives in assistant timeline messages", () => {
    const message = [
      "I created and started working on the task:",
      '::task{key="PROD-1" title="Ship task delegation"}',
      "Validation passed.",
    ].join("\n");

    const transformed = transformAssistantTaskDirectives(message, "complete");
    expect(transformed).toBeDefined();
    expect(transformed?.items).toHaveLength(3);
    expect(transformed?.items[1]).toMatchObject({
      type: "plugin",
      kind: "tasks-card",
      version: 1,
      data: {
        taskKey: "PROD-1",
        fallbackTitle: "Ship task delegation",
        valid: true,
        phase: "complete",
      },
    });
  });
});
