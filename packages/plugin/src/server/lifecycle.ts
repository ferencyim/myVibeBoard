import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { SendAgentMessageRequest, WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  labels: Record<string, string>;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    /**
     * @deprecated Always empty. Fetch history on demand with
     * context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
     */
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission_resolved": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  "agent.created": { agent: PluginHookAgent };
  "agent.closed": { agent: PluginHookAgent };
  "workspace.created": { workspace: PluginHookWorkspace };
  "workspace.archived": { workspace: PluginHookWorkspace };
  /** A real user message accepted by ordinary delivery; plugin and agent sends are excluded. */
  "agent.user_prompt_received": {
    agentId: string;
    workspaceId: string | null;
    messageId: string;
    text: string;
    images?: Array<{ data: string; mimeType: string }>;
    attachments?: SendAgentMessageRequest["attachments"];
    sessionMode?: string;
  };
  /**
   * A plugin took an `agent.user_prompt` message over and the host recorded it. Carries what the
   * hook request left out, so the plugin can pass the message on unchanged.
   */
  "agent.user_prompt_handled": {
    agentId: string;
    messageId: string;
    images?: Array<{ data: string; mimeType: string }>;
    attachments?: SendAgentMessageRequest["attachments"];
  };
}

export interface PluginBeforeRequests {
  "agent.create": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    /** Native placement, so transforms can scope themselves to a task workspace. */
    workspaceId?: string;
    parentAgentId?: string | null;
    labels?: Record<string, string>;
  };
  "agent.session_open": PluginSessionOpenRequest;
  /**
   * An agent's send_agent_prompt to another agent, before it is queued. Throwing rejects the
   * prompt and the caller receives the error; a hook may change only the prompt text.
   */
  "agent.prompt": {
    /** The recipient. */
    agentId: string;
    workspaceId: string | null;
    /** The recipient's parent when it is a subagent. */
    parentAgentId: string | null;
    callerAgentId: string;
    prompt: string;
  };
  /**
   * An agent's respond_to_permission for another agent's pending request, before it is applied.
   * Throwing rejects it and the caller receives the error; a hook cannot change the request.
   */
  "agent.permission_response": {
    /** The agent that owns the pending request. */
    agentId: string;
    workspaceId: string | null;
    /** The owner's parent when it is a subagent. */
    parentAgentId: string | null;
    callerAgentId: string;
    requestId: string;
  };
  /**
   * A message a person sent to an agent (composer, phone, voice), before it is delivered.
   * Agent-to-agent and plugin-sent messages do not pass through. Return `{ handled: true, note }`
   * to take the message over: the host records it in the agent's timeline with the note, does not
   * start a turn, then emits `agent.user_prompt_handled` with the original images and attachments.
   * Throwing, returning nothing or not answering within 5 seconds delivers it as usual, so answer
   * at once and do slow work after `agent.user_prompt_handled`.
   */
  "agent.user_prompt": {
    /** The recipient. */
    agentId: string;
    workspaceId: string | null;
    /** The message id the host records it under; `agent.user_prompt_handled` carries it back. */
    messageId: string;
    text: string;
    /** What is attached, without the content: images are `{ type: "image", mimeType }`. */
    attachments?: Array<{ type: string; name?: string; mimeType?: string }>;
    /** A session mode the sender asked for with this message. */
    sessionMode?: string;
    /** Set by a hook that took the message over. */
    handled?: boolean;
    /** Shown in the recipient's timeline when handled. */
    note?: string;
  };
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

/** What a before hook may return: the (changed) request, or for `agent.user_prompt` a takeover. */
export type PluginBeforeResult<Name extends keyof PluginBeforeRequests> =
  | PluginBeforeRequests[Name]
  | (Name extends "agent.user_prompt" ? { handled: true; note?: string } : never)
  | void;

export interface PluginLifecycleRegistration {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeResult<Name> | Promise<PluginBeforeResult<Name>>,
  ): () => void;
}
