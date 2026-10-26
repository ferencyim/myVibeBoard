import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  comparePromptLibraryEntries,
  isNewerPromptLibraryEntry,
  normalizePromptLibraryTag,
  normalizePromptLibraryTags,
  PROMPT_LIBRARY_BODY_MAX_LENGTH,
  PROMPT_LIBRARY_TITLE_MAX_LENGTH,
  promptLibraryTombstone,
  removePromptLibraryTag,
  renamePromptLibraryTag,
} from "@getpaseo/protocol/prompt-library";
import { readPromptLibraryCache, writePromptLibraryCache } from "./cache";
import { collectPromptTags, hasPromptTag, mergeRemoteEntries, sortVisibleEntries } from "./merge";
import type {
  PromptLibraryHostSnapshot,
  PromptLibraryHostStatus,
  PromptLibraryNotice,
  PromptLibraryRemote,
  PromptLibraryStorage,
} from "./types";

// RPC error codes the daemon uses for "this write is invalid"; retrying can never succeed.
const REJECTED_WRITE_CODES = new Set(["prompt_library_invalid", "prompt_library_tag_empty"]);

function isRejectedWrite(error: unknown): boolean {
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === "DaemonRpcError" && typeof code === "string" && REJECTED_WRITE_CODES.has(code);
}

interface HostConnection {
  client: PromptLibraryRemote;
  supported: boolean;
  generation: number;
}

interface HostState {
  serverId: string;
  entries: Map<string, PromptLibraryEntry>;
  pending: Map<string, PromptLibraryEntry>;
  notice: PromptLibraryNotice | null;
  hydrated: boolean;
  hydration: Promise<void> | null;
  status: PromptLibraryHostStatus;
  error: string | null;
  lastTimestampMs: number;
  generationCounter: number;
  connection: HostConnection | null;
  syncing: Promise<void> | null;
  syncingGeneration: number | null;
  persistTail: Promise<void>;
  snapshot: PromptLibraryHostSnapshot | null;
}

export interface PromptLibraryModelOptions {
  storage: PromptLibraryStorage;
  now?: () => Date;
  createId?: () => string;
}

export class PromptLibraryModel {
  private readonly hosts = new Map<string, HostState>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: PromptLibraryModelOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot(serverId: string): PromptLibraryHostSnapshot {
    const host = this.getHost(serverId);
    if (!host.snapshot) this.publish(host);
    return host.snapshot as PromptLibraryHostSnapshot;
  }

  async ensureHydrated(serverId: string): Promise<void> {
    await this.hydrate(serverId);
  }

  async connect(input: {
    serverId: string;
    client: PromptLibraryRemote;
    supported: boolean;
  }): Promise<void> {
    const host = this.getHost(input.serverId);
    await this.hydrate(input.serverId);
    const generation = host.generationCounter + 1;
    host.generationCounter = generation;
    host.connection = {
      client: input.client,
      supported: input.supported,
      generation,
    };
    if (!input.supported) {
      host.status = "unsupported";
      host.error = null;
      this.publish(host);
      return;
    }
    if (!host.hydrated) return; // a later sync retries the cache read
    host.status = "online";
    host.error = null;
    this.publish(host);
    await this.sync(input.serverId);
  }

  disconnect(serverId: string): void {
    const host = this.hosts.get(serverId);
    if (!host) return;
    host.connection = null;
    if (host.status !== "unsupported") host.status = "offline";
    this.publish(host);
  }

  async save(
    serverId: string,
    input: {
      id?: string;
      title: string;
      body: string;
      tags: readonly string[];
    },
  ): Promise<PromptLibraryEntry> {
    const host = this.getHost(serverId);
    await this.requireHydrated(host);
    const title = input.title.trim();
    if (title.length === 0) throw new Error("prompt_title_required");
    if (title.length > PROMPT_LIBRARY_TITLE_MAX_LENGTH) throw new Error("prompt_title_too_long");
    if (input.body.trim().length === 0) throw new Error("prompt_body_required");
    if (input.body.length > PROMPT_LIBRARY_BODY_MAX_LENGTH) throw new Error("prompt_body_too_long");
    const existing = input.id ? host.entries.get(input.id) : undefined;
    const entry: PromptLibraryEntry = {
      id: existing?.id ?? input.id ?? this.createId(),
      title,
      body: input.body,
      tags: normalizePromptLibraryTags(input.tags),
      updatedAt: this.nextTimestamp(host),
      deleted: false,
    };
    host.entries.set(entry.id, entry);
    host.pending.set(entry.id, entry);
    await this.persist(host);
    this.publish(host);
    this.scheduleSync(host);
    return entry;
  }

  async remove(serverId: string, id: string): Promise<void> {
    const host = this.getHost(serverId);
    await this.requireHydrated(host);
    const existing = host.entries.get(id);
    if (!existing || existing.deleted) return;
    const tombstone = promptLibraryTombstone({ id, updatedAt: this.nextTimestamp(host) });
    host.entries.set(id, tombstone);
    host.pending.set(id, tombstone);
    await this.persist(host);
    this.publish(host);
    this.scheduleSync(host);
  }

  async renameTag(serverId: string, from: string, to: string): Promise<void> {
    const host = this.getHost(serverId);
    await this.requireHydrated(host);
    const source = requireTag(from);
    const target = requireTag(to);
    const connection = this.onlineConnection(host);
    if (connection) {
      try {
        await this.sync(serverId);
        const result = await connection.client.renamePromptLibraryTag({
          from: source,
          to: target,
        });
        if (this.isCurrent(host, connection)) {
          mergeRemoteEntries({ ...host, remote: result.entries });
          await this.persist(host);
          this.publish(host);
          return;
        }
      } catch {
        // Fall through to the local queue; the next sync reconciles whatever landed.
      }
    }
    const stamp = this.nextTimestamp(host);
    let changed = false;
    for (const entry of host.entries.values()) {
      if (entry.deleted || !hasPromptTag(entry, source)) continue;
      const tags = renamePromptLibraryTag(entry.tags, source, target);
      const next = { ...entry, tags, updatedAt: stamp };
      host.entries.set(entry.id, next);
      host.pending.set(entry.id, next);
      changed = true;
    }
    if (!changed) return;
    await this.persist(host);
    this.publish(host);
    this.scheduleSync(host);
  }

  async deleteTag(serverId: string, tag: string): Promise<void> {
    const host = this.getHost(serverId);
    await this.requireHydrated(host);
    const source = requireTag(tag);
    const connection = this.onlineConnection(host);
    if (connection) {
      try {
        await this.sync(serverId);
        const result = await connection.client.deletePromptLibraryTag({ tag: source });
        if (this.isCurrent(host, connection)) {
          mergeRemoteEntries({ ...host, remote: result.entries });
          await this.persist(host);
          this.publish(host);
          return;
        }
      } catch {
        // Fall through to the local queue.
      }
    }
    const stamp = this.nextTimestamp(host);
    let changed = false;
    for (const entry of host.entries.values()) {
      if (entry.deleted || !hasPromptTag(entry, source)) continue;
      const next = {
        ...entry,
        tags: removePromptLibraryTag(entry.tags, source),
        updatedAt: stamp,
      };
      host.entries.set(entry.id, next);
      host.pending.set(entry.id, next);
      changed = true;
    }
    if (!changed) return;
    await this.persist(host);
    this.publish(host);
    this.scheduleSync(host);
  }

  dismissNotice(serverId: string): void {
    const host = this.hosts.get(serverId);
    if (!host?.notice) return;
    host.notice = null;
    this.publish(host);
  }

  async sync(serverId: string): Promise<void> {
    const host = this.getHost(serverId);
    await this.hydrate(serverId);
    if (!host.hydrated) return;
    const connection = this.onlineConnection(host);
    if (!connection) return;
    if (host.syncing) {
      if (host.syncingGeneration === connection.generation) return host.syncing;
      await host.syncing.catch(() => undefined);
      const current = this.onlineConnection(host);
      if (!current) return;
      if (current.generation !== connection.generation) return this.sync(serverId);
    }
    const syncing = this.runSync(host, connection).finally(() => {
      host.syncing = null;
      host.syncingGeneration = null;
    });
    host.syncing = syncing;
    host.syncingGeneration = connection.generation;
    return syncing;
  }

  private async runSync(host: HostState, connection: HostConnection): Promise<void> {
    try {
      const remote = await connection.client.listPromptLibrary();
      if (!this.isCurrent(host, connection)) return;
      const overridden = mergeRemoteEntries({ ...host, remote: remote.entries }).overridden;
      if (overridden > 0) host.notice = "overridden";
      this.publish(host);

      const remoteById = new Map(remote.entries.map((entry) => [entry.id, entry]));
      const pending = [...host.pending.values()].sort(comparePromptLibraryEntries);
      let rejected = 0;
      for (const queued of pending) {
        if (!this.isCurrent(host, connection)) return;
        if (!isQueued(host, queued)) continue;
        let result;
        try {
          result = queued.deleted
            ? await connection.client.deletePromptLibrary({
                id: queued.id,
                updatedAt: queued.updatedAt,
              })
            : await connection.client.upsertPromptLibrary({ entry: queued });
        } catch (error) {
          // A refused write would fail forever; roll it back and keep pushing the rest. Anything
          // else (network, timeout) stops this round and leaves the queue for the next one.
          if (!isRejectedWrite(error)) throw error;
          if (!this.isCurrent(host, connection)) return;
          if (isQueued(host, queued)) this.rollBack(host, queued.id, remoteById.get(queued.id));
          rejected += 1;
          continue;
        }
        if (!this.isCurrent(host, connection)) return;
        if (isQueued(host, queued)) {
          // The host's stored entry is the truth, including a clamped timestamp.
          host.pending.delete(queued.id);
          host.entries.set(queued.id, result.entry);
          if (!result.applied) host.notice = "overridden";
        } else {
          const local = host.entries.get(queued.id);
          if (isNewerPromptLibraryEntry(result.entry, local))
            host.entries.set(queued.id, result.entry);
        }
      }
      if (rejected > 0) host.notice = "rejected";
      host.status = "online";
      host.error = null;
    } catch {
      host.status = "offline";
      host.error = "prompt_library_sync_failed";
    } finally {
      await this.persist(host).catch(() => undefined);
      this.publish(host);
    }
  }

  private rollBack(host: HostState, id: string, remote: PromptLibraryEntry | undefined): void {
    host.pending.delete(id);
    if (remote) host.entries.set(id, remote);
    else host.entries.delete(id);
  }

  private async requireHydrated(host: HostState): Promise<void> {
    await this.hydrate(host.serverId);
    if (!host.hydrated) throw new Error("prompt_library_cache_failed");
  }

  /** Callers must check `host.hydrated`: a failed cache read leaves it false and is retried. */
  private async hydrate(serverId: string): Promise<void> {
    const host = this.getHost(serverId);
    if (host.hydrated) return;
    if (!host.hydration) {
      host.hydration = this.readCache(host).finally(() => {
        host.hydration = null;
      });
    }
    await host.hydration;
  }

  private async readCache(host: HostState): Promise<void> {
    try {
      const cache = await readPromptLibraryCache(this.options.storage, host.serverId);
      if (cache) {
        for (const entry of cache.entries) {
          host.entries.set(entry.id, entry);
          host.lastTimestampMs = Math.max(host.lastTimestampMs, timestampMs(entry.updatedAt));
        }
        for (const entry of cache.pending) {
          host.pending.set(entry.id, entry);
          host.lastTimestampMs = Math.max(host.lastTimestampMs, timestampMs(entry.updatedAt));
        }
      }
      host.hydrated = true;
      if (host.error === "prompt_library_cache_failed") {
        host.status = host.connection?.supported ? "online" : "idle";
        host.error = null;
      }
    } catch {
      // Stay unhydrated so nothing is persisted over a cache we could not read; the next call
      // retries the read.
      host.status = "error";
      host.error = "prompt_library_cache_failed";
    } finally {
      this.publish(host);
    }
  }

  private persist(host: HostState): Promise<void> {
    const snapshot = {
      entries: [...host.entries.values()],
      pending: [...host.pending.values()],
    };
    const write = host.persistTail
      .catch(() => undefined)
      .then(() => writePromptLibraryCache(this.options.storage, host.serverId, snapshot));
    host.persistTail = write;
    return write;
  }

  private scheduleSync(host: HostState): void {
    if (!this.onlineConnection(host)) return;
    void this.sync(host.serverId).catch(() => undefined);
  }

  private onlineConnection(host: HostState): HostConnection | null {
    const connection = host.connection;
    if (!connection || !connection.supported) return null;
    return connection;
  }

  private isCurrent(host: HostState, connection: HostConnection): boolean {
    return host.connection === connection;
  }

  private nextTimestamp(host: HostState): string {
    const nextMs = Math.max(this.now().getTime(), host.lastTimestampMs + 1);
    host.lastTimestampMs = nextMs;
    return new Date(nextMs).toISOString();
  }

  private getHost(serverId: string): HostState {
    const existing = this.hosts.get(serverId);
    if (existing) return existing;
    const host: HostState = {
      serverId,
      entries: new Map(),
      pending: new Map(),
      notice: null,
      hydrated: false,
      hydration: null,
      status: "idle",
      error: null,
      lastTimestampMs: 0,
      generationCounter: 0,
      connection: null,
      syncing: null,
      syncingGeneration: null,
      persistTail: Promise.resolve(),
      snapshot: null,
    };
    this.hosts.set(serverId, host);
    return host;
  }

  private publish(host: HostState): void {
    const entries = sortVisibleEntries(host.entries.values());
    host.snapshot = {
      serverId: host.serverId,
      entries,
      tags: collectPromptTags(entries),
      pendingCount: host.pending.size,
      pendingIds: [...host.pending.keys()],
      status: host.status,
      error: host.error,
      notice: host.notice,
      hydrated: host.hydrated,
    };
    for (const listener of this.listeners) listener();
  }
}

function isQueued(host: HostState, entry: PromptLibraryEntry): boolean {
  return host.pending.get(entry.id)?.updatedAt === entry.updatedAt;
}

function requireTag(raw: string): string {
  const tag = normalizePromptLibraryTag(raw);
  if (tag.length === 0) throw new Error("prompt_tag_required");
  return tag;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
