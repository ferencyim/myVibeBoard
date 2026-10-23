import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
import type { TaskConversationRecipient, TaskConversationRow } from "@getpaseo/protocol/messages";

export interface PluginTaskConversationPrepareRequest {
  conversationId: string;
  workspaceId: string;
  ownerPluginId: string;
  anchorAgentId: string | null;
  memberId: string;
  backendAgentId: string;
  recipient: TaskConversationRecipient;
  clientMessageId: string;
  text: string;
  throughSeq: number;
  publicContext: TaskConversationRow[];
  ready: boolean;
  config?: AgentSessionConfig;
  env?: Record<string, string>;
  context?: string;
  summary?: { text: string; throughSeq: number };
  reason?: string;
}

export interface PluginTaskConversationAdmitRequest {
  conversationId: string;
  workspaceId: string;
  ownerPluginId: string;
  anchorAgentId: string | null;
  memberId: string;
  backendAgentId: string;
  recipient: TaskConversationRecipient;
  clientMessageId: string;
  operation: "send" | "compact" | "create";
  admitted: boolean;
  reason?: string;
}

export interface PluginTaskConversationControlRequest {
  conversationId: string;
  workspaceId: string;
  ownerPluginId: string;
  action: "stop" | "archive" | "compact" | "stop_member";
  backendAgentId?: string;
  phase: "before" | "settled" | "unknown";
}

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
  taskConversationId?: string;
  taskConversationMemberId?: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
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
}

export interface PluginBeforeRequests {
  "agent.create": { config: AgentSessionConfig; env?: Record<string, string> };
  "agent.session_open": PluginSessionOpenRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
  "task.conversation.prepare": PluginTaskConversationPrepareRequest;
  "task.conversation.admit": PluginTaskConversationAdmitRequest;
  "task.conversation.control": PluginTaskConversationControlRequest;
}

type TaskConversationHook<Name extends keyof PluginBeforeRequests> = (
  input: { request: PluginBeforeRequests[Name] },
  context: PluginHookContext,
) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>;

export interface PluginTaskConversationHooks {
  prepare: TaskConversationHook<"task.conversation.prepare">;
  admit: TaskConversationHook<"task.conversation.admit">;
  beforeControl?: TaskConversationHook<"task.conversation.control">;
}

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
    ) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>,
  ): () => void;
}
