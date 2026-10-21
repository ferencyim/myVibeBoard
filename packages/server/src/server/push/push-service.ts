import type pino from "pino";

import type { PushChannel } from "./token-store.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface PushGatewayConfig {
  /** Base URL of vibe-push-gateway, e.g. https://host/push */
  url: string;
  authToken?: string;
}

const isExpoToken = (token: string): boolean => /^Expo(nent)?PushToken\[/.test(token);

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;

  private readonly gateway: PushGatewayConfig | undefined;

  constructor(
    logger: pino.Logger,
    revokeToken: (token: string) => void,
    gateway?: PushGatewayConfig,
  ) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
    this.gateway = gateway;
  }

  async sendPush(
    tokens: string[],
    payload: PushPayload,
    channels?: ReadonlyMap<string, PushChannel>,
  ): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    // Native FCM tokens (anything that is not an Expo token) go through the gateway.
    const nativeTokens = tokens.filter((token) => !isExpoToken(token));
    tokens = tokens.filter(isExpoToken);
    if (nativeTokens.length > 0) {
      if (this.gateway) {
        await Promise.all(
          nativeTokens.map((token) => this.sendViaGateway(token, payload, channels?.get(token))),
        );
      } else {
        this.logger.debug(
          { count: nativeTokens.length },
          "Skipping native push tokens: no push gateway configured",
        );
      }
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    await Promise.all(batches.map((batch) => this.sendBatch(batch)));
  }

  private async sendViaGateway(
    token: string,
    payload: PushPayload,
    channel?: PushChannel,
  ): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) return;
    try {
      const response = await fetch(`${gateway.url.replace(/\/+$/, "")}/v1/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gateway.authToken ? { Authorization: `Bearer ${gateway.authToken}` } : {}),
        },
        body: JSON.stringify({
          token,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          // Omitted for fcm so the request is identical to what older daemons send.
          ...(channel && channel !== "fcm" ? { channel } : {}),
        }),
      });
      if (response.status === 404) {
        // Gateway reports the token as unregistered.
        this.revokeToken(token);
        return;
      }
      if (!response.ok) {
        this.logger.error({ status: response.status }, "Push gateway error");
      }
    } catch (error) {
      this.logger.error({ err: error }, "Failed to reach push gateway");
    }
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<void> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return;
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      this.handleTickets(messages, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
    }
  }

  private handleTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): void {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (
          ticket.details?.error === "DeviceNotRegistered" ||
          ticket.details?.error === "InvalidCredentials"
        ) {
          this.revokeToken(message.to);
        }
      }
    }
  }
}
