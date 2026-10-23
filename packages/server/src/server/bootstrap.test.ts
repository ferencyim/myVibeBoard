import { expect, test } from "vitest";
import pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";

import { closeAllAgents, fanOutReconciledWorkspaceUpdates } from "./bootstrap.js";

test("daemon shutdown closes running task members with control authority", async () => {
  let control = false;
  const closed: string[] = [];
  const manager = {
    listAgents: () => [{ id: "running-task-member" }],
    taskConversations: {
      runWithControl: async (callback: () => Promise<void>) => {
        control = true;
        try {
          return await callback();
        } finally {
          control = false;
        }
      },
    },
    closeAgent: async (agentId: string) => {
      expect(control).toBe(true);
      closed.push(agentId);
    },
  } as unknown as AgentManager;

  await closeAllAgents(pino({ level: "silent" }), manager);

  expect(closed).toEqual(["running-task-member"]);
  expect(control).toBe(false);
});

test("daemon shutdown retains ordinary agent close behavior", async () => {
  const closed: string[] = [];
  const manager = {
    listAgents: () => [{ id: "ordinary-agent" }],
    closeAgent: async (agentId: string) => {
      closed.push(agentId);
    },
  } as unknown as AgentManager;

  await closeAllAgents(pino({ level: "silent" }), manager);

  expect(closed).toEqual(["ordinary-agent"]);
});

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});
