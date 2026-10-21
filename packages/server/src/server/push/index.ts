import type pino from "pino";

import { PushService, type PushGatewayConfig, type PushPayload } from "./push-service.js";
import { PushTokenStore, type PushChannel } from "./token-store.js";

export type { PushChannel, PushGatewayConfig, PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string, channel?: PushChannel): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  gateway?: PushGatewayConfig;
  deliver?: (
    tokens: string[],
    payload: PushPayload,
    channels?: ReadonlyMap<string, PushChannel>,
  ) => Promise<void>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(
    options.logger,
    (token) => store.revokeToken(token),
    options.gateway,
  );
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload, channels?: ReadonlyMap<string, PushChannel>) =>
      service.sendPush(tokens, payload, channels));

  return {
    renew(token, channel) {
      store.renewToken(token, channel);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      const channels = store.getChannels(tokens);
      if (channels.size === 0) await deliver(tokens, payload);
      else await deliver(tokens, payload, channels);
    },
  };
}
