import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";
import { z } from "zod";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleRegistration,
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
  "agent.turn_context_delivered",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "workspace.created",
  "workspace.archived",
  "agent.user_prompt_handled",
  "agent.user_prompt_received",
] as const;
export const beforeHookNames = [
  "agent.create",
  "agent.session_open",
  "agent.turn_context",
  "agent.notification",
  "agent.prompt",
  "agent.permission_response",
  "agent.user_prompt",
  "workspace.create",
] as const;

const beforeSchemas = {
  "agent.notification": z
    .object({
      agentId: z.string(),
      reason: z.enum(["finished", "error", "permission"]),
      suppressed: z.boolean().optional(),
    })
    .strict(),
  "agent.turn_context": z
    .object({
      agentId: z.string(),
      context: z.string().optional(),
      deliveryId: z.string().optional(),
    })
    .strict(),
  "agent.create": CreateAgentRequestMessageSchema.pick({
    config: true,
    env: true,
    workspaceId: true,
    labels: true,
  })
    .extend({ parentAgentId: z.string().nullable().optional() })
    .strict(),
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
  "agent.prompt": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      parentAgentId: z.string().nullable(),
      callerAgentId: z.string(),
      prompt: z.string(),
    })
    .strict(),
  "agent.permission_response": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      parentAgentId: z.string().nullable(),
      callerAgentId: z.string(),
      requestId: z.string(),
    })
    .strict(),
  "agent.user_prompt": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      messageId: z.string(),
      text: z.string(),
      attachments: z
        .array(
          z
            .object({
              type: z.string(),
              name: z.string().optional(),
              mimeType: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
      sessionMode: z.string().optional(),
      handled: z.boolean().optional(),
      note: z.string().optional(),
    })
    .strict(),
  "workspace.create": WorkspaceCreateRequestSchema.omit({ type: true, requestId: true }).strict(),
};

export interface PluginLifecycle {
  emit<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    request: PluginBeforeRequests[Name],
  ): Promise<PluginBeforeRequests[Name]>;
  /** False when no plugin registered this before hook, so callers can skip building the request. */
  hasBefore?(name: keyof PluginBeforeRequests): boolean;
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
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
    labels: agent.labels ?? {},
  };
}

export function publishAgentStream(
  lifecycle: PluginLifecycle,
  agent: PluginHookAgent,
  event: AgentStreamEvent,
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn_started", { agent, turnId: event.turnId ?? null });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "completed" },
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      turnId: event.turnId ?? null,
      timeline: [],
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
): { request: PluginBeforeRequests[Name]; stop: boolean } {
  if (name === "agent.user_prompt") {
    const handled = userPromptTakeover(input, output);
    // A takeover ends the chain: later hooks never see a message that is no longer delivered.
    return { request: validateBeforeRequest(name, { ...input, ...handled }), stop: !!handled };
  }
  const result = validateBeforeRequest(name, output);
  if (name === "agent.notification") {
    validateNotificationResult(input, result);
  }
  if (name === "agent.turn_context") {
    validateTurnContextResult(input, result);
  }
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
  if (name === "agent.prompt") {
    const previous = beforeSchemas["agent.prompt"].parse(input);
    const next = beforeSchemas["agent.prompt"].parse(result);
    if (
      previous.agentId !== next.agentId ||
      previous.workspaceId !== next.workspaceId ||
      previous.parentAgentId !== next.parentAgentId ||
      previous.callerAgentId !== next.callerAgentId
    ) {
      throw new Error("agent.prompt hooks can only change the prompt");
    }
  }
  if (name === "agent.permission_response") {
    const previous = beforeSchemas["agent.permission_response"].parse(input);
    const next = beforeSchemas["agent.permission_response"].parse(result);
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new Error("agent.permission_response hooks can only reject");
    }
  }
  if (name === "agent.create") {
    const previous = beforeSchemas["agent.create"].parse(input);
    const next = beforeSchemas["agent.create"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create hooks cannot change the workspace directory");
    }
  }
  return { request: result, stop: false };
}

function validateTurnContextResult(input: unknown, output: unknown): void {
  const previous = beforeSchemas["agent.turn_context"].parse(input);
  const next = beforeSchemas["agent.turn_context"].parse(output);
  if (previous.agentId !== next.agentId) {
    throw new Error("agent.turn_context hooks cannot change the recipient");
  }
}

function validateNotificationResult(input: unknown, output: unknown): void {
  const previous = beforeSchemas["agent.notification"].parse(input);
  const next = beforeSchemas["agent.notification"].parse(output);
  if (
    previous.agentId !== next.agentId ||
    previous.reason !== next.reason ||
    (previous.suppressed === true && next.suppressed !== true)
  ) {
    throw new Error("agent.notification hooks can only suppress notifications");
  }
}

/** A user_prompt hook may only take the message over (`{ handled: true, note? }`), not change it.
 *  Returns the takeover, or null when the hook let the message through. */
function userPromptTakeover(
  input: unknown,
  output: unknown,
): { handled: true; note?: string } | null {
  const { handled, note, ...rest } = z
    .object({ handled: z.boolean().optional(), note: z.string().optional() })
    .passthrough()
    .parse(output);
  const {
    handled: _handled,
    note: _note,
    ...unchanged
  } = beforeSchemas["agent.user_prompt"].parse(input);
  for (const [key, value] of Object.entries(rest)) {
    if (JSON.stringify(value) !== JSON.stringify(unchanged[key as keyof typeof unchanged])) {
      throw new Error("agent.user_prompt hooks can only take the message over");
    }
  }
  if (handled !== true) return null;
  return { handled: true, ...(note ? { note } : {}) };
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
          if (result === undefined) continue;
          const validated = validateBeforeResult(hookName, request, result);
          request = validated.request;
          if (validated.stop) break;
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
