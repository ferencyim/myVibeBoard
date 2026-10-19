import type { AgentAttentionNotificationPayload } from "@getpaseo/protocol/agent-attention-notification";

import type { PersistedConfig } from "../persisted-config.js";
import type { PushGatewayConfig, PushPayload } from "./push-service.js";

export interface ResolvedPushConfig {
  gateway?: PushGatewayConfig;
  minimalPayload: boolean;
}

export function resolvePushConfig(
  persisted: PersistedConfig["daemon"],
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPushConfig {
  const push = persisted?.push;
  const url = push?.gateway;
  const authToken = env.PASEO_PUSH_GATEWAY_TOKEN ?? push?.gatewayToken;
  return {
    gateway: url ? { url, ...(authToken ? { authToken } : {}) } : undefined,
    minimalPayload: push?.minimalPayload ?? url !== undefined,
  };
}

const EVENT_LABELS = {
  permission: "Needs your approval",
  error: "Needs attention",
  finished: "Finished",
} as const;

/** Notification text carrying only the project name and the event type. */
export function toMinimalPayload(
  notification: AgentAttentionNotificationPayload,
  projectName: string | null,
): PushPayload {
  return {
    title: projectName?.trim() || "Paseo",
    body: EVENT_LABELS[notification.data.reason],
    data: notification.data,
  };
}

/**
 * A plugin push about an agent's attention gets the same target fields as Paseo's own agent push
 * (serverId, workspaceId, agentId), so a tap opens that agent instead of the host root.
 */
export function withAgentTarget<T extends { data?: Record<string, unknown> }>(
  notification: T,
  target: { serverId: string; workspaceId: string; agentId: string },
): T {
  return { ...notification, data: { ...target, ...notification.data } };
}

const PLUGIN_ATTENTION_DEDUPE_MS = 2 * 60_000;

/** True when Paseo itself pushed (or deliberately held back) this attention moments ago. */
export function isRecentAttention(
  recent: ReadonlyMap<string, number>,
  agentId: string,
  reason: string,
  nowMs: number,
): boolean {
  const at = recent.get(`${agentId}:${reason}`);
  return at !== undefined && nowMs - at < PLUGIN_ATTENTION_DEDUPE_MS;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/**
 * A plugin-requested push. Minimal mode bounds it to a short title and body and to short string
 * data fields, so a plugin cannot leak content (card text, messages) through the notification.
 */
export function toPluginPayload(
  notification: { title: string; body: string; data?: Record<string, unknown> },
  minimal: boolean,
): PushPayload {
  if (!minimal) {
    return { title: notification.title, body: notification.body, data: notification.data };
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(notification.data ?? {})) {
    if (typeof value === "string" && value.length <= 64) data[key] = value;
  }
  return {
    title: clip(notification.title.trim(), 60) || "Paseo",
    body: clip(notification.body.trim(), 40),
    data,
  };
}

export function toMinimalTerminalPayload(
  projectName: string | null,
  data: Record<string, unknown>,
): PushPayload {
  return { title: projectName?.trim() || "Paseo", body: "Terminal needs attention", data };
}
