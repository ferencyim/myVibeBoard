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

export function toMinimalTerminalPayload(
  projectName: string | null,
  data: Record<string, unknown>,
): PushPayload {
  return { title: projectName?.trim() || "Paseo", body: "Terminal needs attention", data };
}
