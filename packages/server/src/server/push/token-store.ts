import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

/** Delivery channel of a native token. Tokens stored without a channel are "fcm". */
export type PushChannel = "fcm" | "vivo";

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private subscriptions = new Map<string, number>();
  // Only non-fcm tokens appear here; absence means "fcm".
  private channels = new Map<string, PushChannel>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number,
    leaseMs: number,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
    this.loadFromDisk();
  }

  renewToken(token: string, channel: PushChannel = "fcm"): void {
    const normalized = token.trim();
    if (!normalized) return;
    const now = this.now();
    const currentExpiry = this.subscriptions.get(normalized);
    const sameChannel = this.channelOf(normalized) === channel;
    if (currentExpiry !== undefined && sameChannel && currentExpiry - now > this.leaseMs / 2) {
      return;
    }
    const next = new Map(this.subscriptions);
    next.set(normalized, now + this.leaseMs);
    const nextChannels = new Map(this.channels);
    if (channel === "fcm") nextChannels.delete(normalized);
    else nextChannels.set(normalized, channel);
    this.persist(next, nextChannels);
    this.subscriptions = next;
    this.channels = nextChannels;
    this.logger.debug({ total: this.subscriptions.size }, "Renewed token");
  }

  revokeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (!this.subscriptions.has(normalized)) return;
    const next = new Map(this.subscriptions);
    next.delete(normalized);
    const nextChannels = new Map(this.channels);
    nextChannels.delete(normalized);
    this.persist(next, nextChannels);
    this.subscriptions = next;
    this.channels = nextChannels;
    this.logger.debug({ total: this.subscriptions.size }, "Revoked token");
  }

  channelOf(token: string): PushChannel {
    return this.channels.get(token) ?? "fcm";
  }

  /** Non-fcm channels of the given tokens; empty when every token is fcm/Expo. */
  getChannels(tokens: readonly string[]): ReadonlyMap<string, PushChannel> {
    const out = new Map<string, PushChannel>();
    for (const token of tokens) {
      const channel = this.channels.get(token);
      if (channel) out.set(token, channel);
    }
    return out;
  }

  getActiveTokens(): string[] {
    const now = this.now();
    const active = new Map(this.subscriptions);
    for (const [token, expiresAt] of this.subscriptions) {
      if (expiresAt <= now) {
        active.delete(token);
      }
    }
    if (active.size !== this.subscriptions.size) {
      try {
        const activeChannels = new Map(this.channels);
        for (const token of this.channels.keys()) {
          if (!active.has(token)) activeChannels.delete(token);
        }
        this.persist(active, activeChannels);
        this.subscriptions = active;
        this.channels = activeChannels;
      } catch {
        // Keep the previous state so a later send retries pruning. Expired tokens
        // are still excluded from this delivery.
      }
    }
    return Array.from(active.keys());
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { subscriptions?: unknown; tokens?: unknown };
      const loaded = new Map<string, number>();
      const loadedChannels = new Map<string, PushChannel>();
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as { token?: unknown; expiresAt?: unknown; channel?: unknown };
        if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string")
          continue;
        const token = candidate.token.trim();
        const expiresAt = Date.parse(candidate.expiresAt);
        if (token && Number.isFinite(expiresAt)) {
          loaded.set(token, expiresAt);
          if (candidate.channel === "vivo") loadedChannels.set(token, "vivo");
        }
      }
      this.subscriptions = loaded;
      this.channels = loadedChannels;

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      if (legacyTokens.length > 0) {
        const migrated = new Map(loaded);
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) migrated.set(normalized, expiresAt);
        }
        this.persist(migrated, this.channels);
        this.subscriptions = migrated;
      }
      this.logger.info({ total: this.subscriptions.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(
    subscriptions: ReadonlyMap<string, number>,
    channels: ReadonlyMap<string, PushChannel>,
  ): void {
    try {
      const payload =
        JSON.stringify(
          {
            subscriptions: Array.from(subscriptions, ([token, expiresAt]) => ({
              token,
              expiresAt: new Date(expiresAt).toISOString(),
              ...(channels.has(token) ? { channel: channels.get(token) } : {}),
            })),
          },
          null,
          2,
        ) + "\n";
      this.write(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
      throw err;
    }
  }
}
