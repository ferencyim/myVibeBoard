import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { AgentStorage } from "./agent-storage.js";
import { AgentDirectory } from "./directory.js";
import type { AgentManager } from "./agent-manager.js";
import { createStub } from "../test-utils/class-mocks.js";
import { serializeAgentSnapshot } from "../messages.js";
import { DirectorySyncService } from "../directory-sync/index.js";
import { describeHookAgent } from "../plugins/lifecycle/index.js";
import {
  TASK_CONVERSATION_ID_LABEL,
  TASK_CONVERSATION_MEMBER_ID_LABEL,
} from "../task-conversation/identity.js";
import { describe, expect, it } from "vitest";

import { AGENT_LIFECYCLE_STATUSES } from "./agent-manager.js";
import {
  buildStoredAgentPayload,
  toAgentPayload,
  toAgentListItemPayload,
  toRecentProviderSessionDescriptorPayload,
  toStoredAgentRecord,
  type ManagedAgent,
} from "./agent-projections.js";
import type { AgentSession } from "./agent-sdk-types.js";
import type {
  AgentFeature,
  ImportableProviderSession,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<Partial<ManagedAgent>, "config" | "pendingPermissions"> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
};

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const baseConfig: AgentSessionConfig = {
    provider: "claude",
    cwd: "/tmp/project",
    modeId: "plan",
    model: "claude-3.5-sonnet",
    providerOptions: { allowedTools: ["Read"] },
  };

  const basePersistence: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: "persist-1",
    metadata: { branch: "feature/refactor" },
  };

  const configOverrides = overrides.config ?? {};
  const {
    config: _ignoredConfig,
    pendingPermissions: pendingPermissionsOverride,
    lifecycle = "idle",
    ...restOverrides
  } = overrides;

  const sessionValue =
    lifecycle === "closed" ? null : (restOverrides.session ?? ({} as AgentSession));
  const activeForegroundTurnIdValue =
    restOverrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  const lastErrorValue =
    restOverrides.lastError ?? (lifecycle === "error" ? "encountered error" : undefined);

  const agent: ManagedAgent = {
    id: "agent-123",
    provider: "claude",
    cwd: "/tmp/project",
    session: sessionValue,
    sessionId: "session-123",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    config: { ...baseConfig, ...configOverrides },
    lifecycle,
    createdAt: now,
    updatedAt: now,
    availableModes: [
      { id: "plan", label: "Planning" },
      { id: "build", label: "Building", description: "Detailed" },
    ],
    currentModeId: "plan",
    pendingPermissions: pendingPermissionsOverride ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: activeForegroundTurnIdValue,
    activeTurnId: activeForegroundTurnIdValue,
    activeTurnStartedAt: lifecycle === "running" ? new Date("2025-01-01T00:00:01.000Z") : null,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: [],
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    },
    persistence: { ...basePersistence },
    lastUsage: undefined,
    lastError: lastErrorValue,
    historyPrimed: true,
    lastUserMessageAt: now,
    attention: { requiresAttention: false },
  };

  return {
    ...agent,
    ...restOverrides,
    lifecycle,
    config: agent.config,
    pendingPermissions: agent.pendingPermissions,
  };
}

it("projects the daemon-owned active turn identity", () => {
  expect(toAgentPayload(createManagedAgent({ lifecycle: "running" })).activeTurn).toEqual({
    turnId: "test-turn-id",
    startedAt: "2025-01-01T00:00:01.000Z",
  });
});

function createPermission(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  const base: AgentPermissionRequest = {
    id: "perm-1",
    provider: "claude",
    name: "execute_command",
    kind: "tool",
    title: "Run command",
    description: "Execute shell command",
    input: { command: "ls", args: undefined },
    suggestions: [{ behavior: "allow" }],
    metadata: { requestedAt: new Date("2025-02-01T12:00:00.000Z") },
  };
  return { ...base, ...overrides };
}

function createFeature(overrides: Partial<AgentFeature> = {}): AgentFeature {
  return {
    type: "toggle",
    id: "fast_mode",
    label: "Fast mode",
    value: true,
    ...overrides,
  };
}

describe("toStoredAgentRecord", () => {
  it("captures lifecycle metadata, config, and persistence", () => {
    const agent = createManagedAgent({
      currentModeId: "focus",
      persistence: {
        provider: "claude",
        sessionId: "persist-2",
        metadata: { resumedAt: new Date("2025-01-05T00:00:00.000Z"), note: "warm" },
      },
    });

    const record = toStoredAgentRecord(agent, { title: "Refactor Agent" });

    expect(record).toMatchObject({
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      title: "Refactor Agent",
      lastStatus: agent.lifecycle,
      lastModeId: "focus",
    });
    expect(record.createdAt).toBe(agent.createdAt.toISOString());
    expect(record.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastActivityAt).toBe(agent.updatedAt.toISOString());
    expect(record.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(record.persistence).toEqual({
      provider: "claude",
      sessionId: "persist-2",
      metadata: {
        resumedAt: "2025-01-05T00:00:00.000Z",
        note: "warm",
      },
    });
    expect(record.runtimeInfo).toEqual({
      provider: "claude",
      sessionId: "session-123",
      model: "claude-3.5-sonnet",
      modeId: "plan",
    });
    expect(record.config).toEqual({
      modeId: agent.config.modeId,
      model: agent.config.model,
      providerOptions: { allowedTools: ["Read"] },
    });

    record.config!.providerOptions!.allowedTools = ["Bash"];
    expect(agent.config.providerOptions!.allowedTools).toEqual(["Read"]);
    record.persistence!.sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-2");
  });

  it("falls back to config mode when current mode is null and handles null title", () => {
    const agent = createManagedAgent({
      currentModeId: null,
      config: { modeId: "auto" },
      lastUserMessageAt: null,
    });

    const record = toStoredAgentRecord(agent);
    expect(record.title).toBeNull();
    expect(record.lastModeId).toBe("auto");
    expect(record.lastUserMessageAt).toBeNull();
  });

  it("omits config when no serializable fields exist", () => {
    const agent = createManagedAgent({
      config: {
        modeId: undefined,
        model: undefined,
        providerOptions: undefined,
        toolPolicy: undefined,
      },
    });

    const record = toStoredAgentRecord(agent);
    expect(record.config).toBeNull();
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const record = toStoredAgentRecord(agent);
      expect(record.lastStatus).toBe(status);
    }
  });
});

describe("toAgentPayload", () => {
  it("serializes dates, clones arrays, and hides session", () => {
    const permissionA = createPermission({ id: "perm-a" });
    const permissionB = createPermission({
      id: "perm-b",
      provider: "codex",
      metadata: { requestedAt: new Date("2025-02-02T00:00:00.000Z"), extra: { flag: true } },
    });
    const pending = new Map([
      [permissionA.id, permissionA],
      [permissionB.id, permissionB],
    ]);
    const agent = createManagedAgent({
      pendingPermissions: pending,
      lastUsage: { inputTokens: 10, outputTokens: 20 },
      lastError: "boom",
    });

    const payload = toAgentPayload(agent, { title: "UI Payload" });

    expect(payload.createdAt).toBe(agent.createdAt.toISOString());
    expect(payload.updatedAt).toBe(agent.updatedAt.toISOString());
    expect(payload.lastUserMessageAt).toBe(agent.lastUserMessageAt?.toISOString());
    expect(payload.title).toBe("UI Payload");
    expect(payload.model).toBe(agent.config.model);
    expect(payload.thinkingOptionId).toBeNull();
    expect(payload.pendingPermissions.map((item) => item.id)).toEqual(["perm-a", "perm-b"]);
    expect(payload.pendingPermissions[0]).not.toBe(permissionA);
    expect(payload.pendingPermissions[0].input).toEqual({ command: "ls" });
    expect(payload.pendingPermissions[1].metadata).toEqual({
      requestedAt: "2025-02-02T00:00:00.000Z",
      extra: { flag: true },
    });
    expect(payload.runtimeInfo).toEqual(agent.runtimeInfo);
    expect(payload.runtimeInfo).not.toBe(agent.runtimeInfo);
    expect(payload.availableModes).not.toBe(agent.availableModes);
    expect(payload.availableModes).toEqual(agent.availableModes);
    expect(payload.capabilities).not.toBe(agent.capabilities);
    expect(payload.capabilities).toEqual(agent.capabilities);
    expect(payload.lastUsage).toEqual(agent.lastUsage);
    expect(payload.lastUsage).not.toBe(agent.lastUsage);
    expect(payload.lastError).toBe("boom");
    expect((payload as unknown as { session?: unknown }).session).toBeUndefined();

    payload.availableModes[0].label = "Changed";
    expect(agent.availableModes[0].label).toBe("Planning");
    payload.capabilities.supportsStreaming = false;
    expect(agent.capabilities.supportsStreaming).toBe(true);
    payload.pendingPermissions[0].title = "Mutated title";
    expect(permissionA.title).toBe("Run command");
  });

  it("omits usage when any numeric usage field is NaN", () => {
    const fields = [
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "totalCostUsd",
      "contextWindowMaxTokens",
      "contextWindowUsedTokens",
    ] as const;

    for (const field of fields) {
      const agent = createManagedAgent({
        lastUsage: {
          inputTokens: 10,
          cachedInputTokens: 5,
          outputTokens: 20,
          totalCostUsd: 0.5,
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 100_000,
          [field]: Number.NaN,
        },
      });

      const payload = toAgentPayload(agent);
      expect(payload.lastUsage).toBeUndefined();
    }
  });

  it("produces null title and current mode even without overrides", () => {
    const agent = createManagedAgent({ currentModeId: null, lastUserMessageAt: null });
    const payload = toAgentPayload(agent);
    expect(payload.title).toBeNull();
    expect(payload.currentModeId).toBeNull();
    expect(payload.lastUserMessageAt).toBeNull();
    expect(payload.pendingPermissions).toEqual([]);
  });

  it("propagates lifecycle status for all states", () => {
    for (const status of AGENT_LIFECYCLE_STATUSES) {
      const agent = createManagedAgent({ lifecycle: status });
      const payload = toAgentPayload(agent);
      expect(payload.status).toBe(status);
    }
  });

  it("keeps persistence handles sanitized and detached", () => {
    const agent = createManagedAgent({
      persistence: {
        provider: "codex",
        sessionId: "persist-99",
        nativeHandle: { id: "native" } as unknown,
        metadata: {
          restored: new Date("2025-03-01T00:00:00.000Z"),
          empty: {},
          mcpServers: {
            hub: {
              type: "http",
              headers: { Authorization: "Bearer projection-secret" },
            },
          },
        },
      },
    });
    const payload = toAgentPayload(agent);
    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-99",
      nativeHandle: { id: "native" },
      metadata: { restored: "2025-03-01T00:00:00.000Z" },
    });
    (payload.persistence as AgentPersistenceHandle).sessionId = "mutated";
    expect(agent.persistence!.sessionId).toBe("persist-99");
  });

  it("removes empty persistence metadata after projecting MCP configuration", () => {
    const payload = toAgentPayload(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-mcp-only",
          metadata: { mcpServers: { hub: { type: "http", url: "https://hub.test/mcp" } } },
        },
      }),
    );

    expect(payload.persistence).toEqual({
      provider: "codex",
      sessionId: "persist-mcp-only",
    });
  });

  it("strips MCP metadata from stored wire payloads while preserving private persistence", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({
        provider: "codex",
        config: { provider: "codex" },
        persistence: {
          provider: "codex",
          sessionId: "persist-stored",
          metadata: {
            conversationId: "conversation-stored",
            mcpServers: {
              hub: {
                type: "http",
                headers: { Authorization: "Bearer stored-projection-secret" },
              },
            },
          },
        },
      }),
    );

    const payload = buildStoredAgentPayload(record, ["codex"]);

    expect(record.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
      mcpServers: {
        hub: {
          type: "http",
          headers: { Authorization: "Bearer stored-projection-secret" },
        },
      },
    });
    expect(payload.persistence?.metadata).toEqual({
      conversationId: "conversation-stored",
    });
  });

  it("carries a stored lastError onto the payload", () => {
    const record = toStoredAgentRecord(
      createManagedAgent({ provider: "codex", config: { provider: "codex" }, lastError: "boom" }),
    );

    expect(buildStoredAgentPayload(record, ["codex"]).lastError).toBe("boom");
    expect(buildStoredAgentPayload({ ...record, lastError: null }, ["codex"])).not.toHaveProperty(
      "lastError",
    );
  });

  it("omits lastUsage when not available", () => {
    const agent = createManagedAgent({ lastUsage: undefined });
    const payload = toAgentPayload(agent);
    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("preserves context window usage fields when they are valid numbers", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 42_000,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 42_000,
    });
  });

  it("omits lastUsage when context window usage fields are invalid", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        contextWindowMaxTokens: "200000" as unknown as number,
        contextWindowUsedTokens: NaN,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload).not.toHaveProperty("lastUsage");
  });

  it("keeps existing lastUsage behavior when context window fields are absent", () => {
    const agent = createManagedAgent({
      lastUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalCostUsd: 1.25,
      },
    });

    const payload = toAgentPayload(agent);

    expect(payload.lastUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalCostUsd: 1.25,
    });
  });

  it("includes features in the snapshot payload", () => {
    const features = [createFeature()];
    const agent = createManagedAgent({ features });

    const payload = toAgentPayload(agent);

    expect(payload.features).toEqual(features);
  });
});

describe("toRecentProviderSessionDescriptorPayload", () => {
  it("projects provider import rows to provider-opaque public recent sessions", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "codex-custom",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
    };

    const payload = toRecentProviderSessionDescriptorPayload(session, {
      providerLabel: "Custom Codex",
    });

    expect(payload).toEqual({
      providerId: "codex-custom",
      providerLabel: "Custom Codex",
      providerHandleId: "provider-native-handle",
      cwd: "/tmp/project",
      title: "Import me",
      firstPromptPreview: "First prompt with spacing",
      lastPromptPreview: "Second prompt",
      lastActivityAt: "2026-04-30T12:34:56.000Z",
    });
    expect(payload).not.toHaveProperty("providerKind");
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("nativeHandle");
  });

  it("preserves null prompt previews", () => {
    const session: ImportableProviderSession & { provider: string } = {
      provider: "claude-custom",
      providerHandleId: "provider-session-id",
      cwd: "/tmp/project",
      title: null,
      lastActivityAt: new Date("2026-04-30T12:34:56.000Z"),
      firstPromptPreview: null,
      lastPromptPreview: null,
    };

    expect(
      toRecentProviderSessionDescriptorPayload(session, {
        providerLabel: "Custom Claude",
      }),
    ).toMatchObject({
      providerId: "claude-custom",
      providerLabel: "Custom Claude",
      providerHandleId: "provider-session-id",
      firstPromptPreview: null,
      lastPromptPreview: null,
    });
  });
});

describe("task conversation membership projections", () => {
  const identity = {
    taskConversationId: "task-container",
    taskConversationMemberId: "task-member",
  };
  const labels = {
    [TASK_CONVERSATION_ID_LABEL]: identity.taskConversationId,
    [TASK_CONVERSATION_MEMBER_ID_LABEL]: identity.taskConversationMemberId,
  };

  it("publishes membership in the first live snapshot, hook event, and thin list item", () => {
    const agent = createManagedAgent({ labels });
    const snapshot = serializeAgentSnapshot(agent);
    expect(snapshot).toMatchObject(identity);
    expect(toAgentPayload(agent)).toMatchObject(identity);
    expect(toAgentListItemPayload(snapshot)).toMatchObject(identity);
    expect(describeHookAgent(agent)).toMatchObject(identity);
  });

  it("retains membership in real storage, history and directory synchronization after restart", async () => {
    const root =
      process.env.PASEO_TEST_HOME ?? join(process.cwd(), ".dev", "task-conversation-tests");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "membership-projection-"));
    const logger = pino({ level: "silent" });
    const member = createManagedAgent({ labels });
    const history = createManagedAgent({
      id: "archived-member",
      labels: { ...labels, [TASK_CONVERSATION_MEMBER_ID_LABEL]: "old-member" },
    });
    const record = toStoredAgentRecord(member);
    const archivedRecord = { ...toStoredAgentRecord(history), archivedAt: "2026-10-23T00:00:00Z" };
    const storage = new AgentStorage(directory, logger);
    await storage.upsert(record);
    await storage.upsert(archivedRecord);
    const restartedStorage = new AgentStorage(directory, logger);
    const restored = await restartedStorage.get(member.id);
    if (!restored) throw new Error("Missing persisted member");
    const restoredPayload = buildStoredAgentPayload(restored, ["claude"]);
    expect(restoredPayload).toMatchObject(identity);
    expect(toAgentListItemPayload(restoredPayload)).toMatchObject(identity);
    const agents = new AgentDirectory({
      manager: createStub<AgentManager>({ listAgents: () => [] }),
      storage: restartedStorage,
      workspaces: { list: async () => [], get: async () => null },
      projectLive: async (agent) => toAgentPayload(agent),
      projectStored: (stored) => buildStoredAgentPayload(stored, ["claude"]),
      isProviderVisible: () => true,
      isStoredProviderAvailable: () => true,
    });
    expect(await agents.list()).toEqual([expect.objectContaining(identity)]);
    expect(await agents.list({ includeArchived: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining(identity),
        expect.objectContaining({
          taskConversationId: "task-container",
          taskConversationMemberId: "old-member",
        }),
      ]),
    );
    const project = {
      projectKey: "project",
      projectName: "Project",
      checkout: {
        cwd: "/tmp/project",
        isGit: false as const,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false as const,
        mainRepoRoot: null,
      },
    };
    const sync = new DirectorySyncService();
    const listed = sync.synchronizeAgents([{ agent: restoredPayload, project }], {});
    expect(listed.entries[0].agent).toMatchObject(identity);
    const live = toAgentPayload(createManagedAgent({ labels, lifecycle: "running" }));
    expect(
      sync.sequenceAgentUpdate(
        { kind: "upsert", agent: live },
        { agent: live, project },
        live.id,
        true,
      ),
    ).toMatchObject({ agent: identity });
  });

  it("does not add membership fields to ordinary or partially labelled agents", () => {
    for (const ordinaryLabels of [{}, { [TASK_CONVERSATION_ID_LABEL]: "incomplete" }]) {
      const agent = createManagedAgent({ labels: ordinaryLabels });
      for (const projected of [
        toAgentPayload(agent),
        serializeAgentSnapshot(agent),
        buildStoredAgentPayload(toStoredAgentRecord(agent), ["claude"]),
        toAgentListItemPayload(toAgentPayload(agent)),
        describeHookAgent(agent),
      ]) {
        expect(projected).not.toHaveProperty("taskConversationId");
        expect(projected).not.toHaveProperty("taskConversationMemberId");
      }
    }
  });
});
