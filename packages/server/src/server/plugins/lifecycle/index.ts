import { taskConversationIdentity as projectTaskConversationIdentity } from "../../task-conversation/identity.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import { z } from "zod";
import {
  CreateAgentRequestMessageSchema,
  TaskConversationRecipientSchema,
  TaskConversationRowSchema,
} from "@getpaseo/protocol/messages";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleRegistration,
  PluginTaskConversationHooks,
} from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  PluginBeforeRequests,
  PluginHookWorkspace,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

export const lifecycleEventNames = [
  "agent.created",
  "agent.closed",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "workspace.created",
  "workspace.archived",
] as const;
export const beforeHookNames = [
  "agent.create",
  "agent.session_open",
  "workspace.create",
  "task.conversation.prepare",
  "task.conversation.admit",
  "task.conversation.control",
] as const;

const taskConversationIdentity = z.object({
  conversationId: z.string().min(1),
  workspaceId: z.string().min(1),
  ownerPluginId: z.string().min(1),
});
const taskConversationDelivery = taskConversationIdentity.extend({
  anchorAgentId: z.string().nullable(),
  memberId: z.string().min(1),
  backendAgentId: z.string().min(1),
  recipient: TaskConversationRecipientSchema,
  clientMessageId: z.string().min(1),
});

const beforeSchemas = {
  "agent.create": CreateAgentRequestMessageSchema.pick({ config: true, env: true }).strict(),
  "agent.session_open": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      env: z.record(z.string(), z.string()),
    })
    .strict(),
  "workspace.create": WorkspaceCreateRequestSchema.omit({ type: true, requestId: true }).strict(),
  "task.conversation.prepare": taskConversationDelivery
    .extend({
      text: z.string(),
      throughSeq: z.number().int().nonnegative(),
      publicContext: z.array(TaskConversationRowSchema),
      ready: z.boolean(),
      config: CreateAgentRequestMessageSchema.shape.config.optional(),
      env: z.record(z.string(), z.string()).optional(),
      context: z.string().optional(),
      summary: z
        .object({ text: z.string(), throughSeq: z.number().int().nonnegative() })
        .optional(),
      reason: z.string().optional(),
    })
    .strict(),
  "task.conversation.admit": taskConversationDelivery
    .extend({
      operation: z.enum(["send", "compact", "create"]),
      admitted: z.boolean(),
      reason: z.string().optional(),
    })
    .strict(),
  "task.conversation.control": taskConversationIdentity
    .extend({
      action: z.enum(["stop", "archive", "compact", "stop_member"]),
      backendAgentId: z.string().optional(),
      phase: z.enum(["before", "settled", "unknown"]),
    })
    .strict(),
};

export interface PluginLifecycle {
  emit<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    request: PluginBeforeRequests[Name],
    options?: { pluginId: string },
  ): Promise<PluginBeforeRequests[Name]>;
}

export function validateBeforeRequest<Name extends keyof PluginBeforeRequests>(
  name: Name,
  value: unknown,
): PluginBeforeRequests[Name] {
  return beforeSchemas[name].parse(value) as PluginBeforeRequests[Name];
}

export function describeHookWorkspace(workspace: PersistedWorkspaceRecord): PluginHookWorkspace {
  return {
    id: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    name: workspace.title,
    archivedAt: workspace.archivedAt,
  };
}

export function describeHookAgent(agent: {
  id: string;
  workspaceId?: string;
  provider: string;
  cwd: string;
  title?: string | null;
  labels: Record<string, string>;
}): PluginHookAgent {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
    ...projectTaskConversationIdentity(agent.labels),
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
  };
}

export function publishAgentStream(
  lifecycle: PluginLifecycle,
  agent: PluginHookAgent,
  event: AgentStreamEvent,
  timeline: readonly AgentTimelineItem[],
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn_started", { agent, turnId: event.turnId ?? null });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline,
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline,
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline,
      outcome: { kind: "canceled", reason: event.reason },
    });
  } else if (event.type === "permission_requested") {
    lifecycle.emit("agent.permission_requested", { agent, request: event.request });
  } else if (event.type === "permission_resolved") {
    lifecycle.emit("agent.permission_resolved", {
      agent,
      requestId: event.requestId,
      resolution: event.resolution,
    });
  }
}

export function validateBeforeResult<Name extends keyof PluginBeforeRequests>(
  name: Name,
  input: PluginBeforeRequests[Name],
  output: unknown,
): PluginBeforeRequests[Name] {
  const result = validateBeforeRequest(name, output);
  if (name === "agent.session_open") {
    const previous = beforeSchemas["agent.session_open"].parse(input);
    const next = beforeSchemas["agent.session_open"].parse(result);
    if (
      previous.agentId !== next.agentId ||
      previous.workspaceId !== next.workspaceId ||
      previous.provider !== next.provider ||
      previous.cwd !== next.cwd ||
      previous.reason !== next.reason ||
      previous.purpose !== next.purpose
    ) {
      throw new Error("agent.session_open hooks can only change env");
    }
  }
  if (name === "agent.create") {
    const previous = beforeSchemas["agent.create"].parse(input);
    const next = beforeSchemas["agent.create"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create hooks cannot change the workspace directory");
    }
  }
  if (name === "task.conversation.prepare") {
    const immutable = beforeSchemas["task.conversation.prepare"]
      .omit({
        ready: true,
        config: true,
        env: true,
        context: true,
        summary: true,
        reason: true,
      })
      .strip();
    if (JSON.stringify(immutable.parse(input)) !== JSON.stringify(immutable.parse(result))) {
      throw new Error("Task conversation hooks cannot change the public context boundary");
    }
  }
  if (name === "task.conversation.admit") {
    const immutable = beforeSchemas["task.conversation.admit"]
      .omit({
        admitted: true,
        reason: true,
      })
      .strip();
    if (JSON.stringify(immutable.parse(input)) !== JSON.stringify(immutable.parse(result))) {
      throw new Error("Task conversation hooks cannot change an admission operation");
    }
  }
  if (name === "task.conversation.control") {
    if (JSON.stringify(beforeSchemas[name].parse(input)) !== JSON.stringify(result)) {
      throw new Error("Task conversation hooks cannot change a control operation");
    }
  }
  return result;
}

type Handler = (input: unknown, context: PluginHookContext) => unknown;

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly events = new Map<string, Set<Handler>>();
  private readonly transforms = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();

  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  readonly on: PluginLifecycleRegistration["on"] = (name, handler) => {
    if (!lifecycleEventNames.includes(name)) {
      throw new Error(`Unknown lifecycle event: ${name}`);
    }
    return this.register(this.events, name, handler as Handler);
  };

  readonly before: PluginLifecycleRegistration["before"] = (name, handler) => {
    if (!beforeHookNames.includes(name)) {
      throw new Error(`Unknown before hook: ${name}`);
    }
    return this.register(this.transforms, name, handler as Handler);
  };

  readonly registerTaskConversationHooks = (hooks: PluginTaskConversationHooks): (() => void) => {
    const removePrepare = this.before("task.conversation.prepare", hooks.prepare);
    const removeAdmit = this.before("task.conversation.admit", hooks.admit);
    const removeControl = hooks.beforeControl
      ? this.before("task.conversation.control", hooks.beforeControl)
      : () => {};
    return () => {
      removePrepare();
      removeAdmit();
      removeControl();
    };
  };

  catalog(): { events: string[]; before: string[] } {
    return { events: [...this.events.keys()], before: [...this.transforms.keys()] };
  }

  async invoke(
    id: string,
    kind: "event" | "before",
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<unknown> {
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (kind === "before") {
        if (
          !beforeHookNames.includes(
            name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests,
          )
        ) {
          throw new Error(`Unknown before hook: ${name}`);
        }
        const hookName = name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests;
        let request = validateBeforeRequest(hookName, input);
        for (const handler of this.transforms.get(name) ?? []) {
          controller.signal.throwIfAborted();
          const result = await handler(
            { request: structuredClone(request) },
            { paseo, signal: controller.signal },
          );
          if (result !== undefined) {
            request = validateBeforeResult(hookName, request, result);
          }
        }
        return request;
      }
      for (const handler of this.events.get(name) ?? []) {
        controller.signal.throwIfAborted();
        try {
          await handler(structuredClone(input), { paseo, signal: controller.signal });
        } catch (error) {
          console.error(`Lifecycle hook ${name} failed`, error);
        }
      }
      return null;
    } finally {
      this.active.delete(id);
    }
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.events.clear();
    this.transforms.clear();
  }

  private register(
    registry: Map<string, Set<Handler>>,
    name: string,
    handler: Handler,
  ): () => void {
    let handlers = registry.get(name);
    if (!handlers) {
      handlers = new Set();
      registry.set(name, handlers);
    }
    handlers.add(handler);
    this.changed();
    return () => {
      if (!handlers.delete(handler)) {
        return;
      }
      if (handlers.size === 0) {
        registry.delete(name);
      }
      this.changed();
    };
  }
}
