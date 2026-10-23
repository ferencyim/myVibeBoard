import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { CreationSnapshot, WorkspaceCreateResponse } from "@getpaseo/protocol/messages";
import {
  FirstMessageOutboxInputSchema,
  FirstMessageOutboxStorageSchema,
  type FirstMessageOutboxEntry,
  type FirstMessageOutboxInput,
} from "./model";

export const FIRST_MESSAGE_OUTBOX_STORAGE_KEY = "paseo:first-message-outbox:v1";

export interface FirstMessageOutboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface PreparedFirstMessageAttachments {
  images?: NonNullable<CreateWorkspaceRequestOptions["agent"]>["images"];
  attachments?: NonNullable<CreateWorkspaceRequestOptions["agent"]>["attachments"];
}

export interface FirstMessageOutboxPort {
  getCreation(idempotencyKey: string): Promise<CreationSnapshot | null>;
  prepareAttachments(entry: FirstMessageOutboxEntry): Promise<PreparedFirstMessageAttachments>;
  createWorkspace(
    input: CreateWorkspaceRequestOptions,
  ): Promise<WorkspaceCreateResponse["payload"]>;
}

interface FirstMessageOutboxOptions {
  storage: FirstMessageOutboxStorage;
  storageKey?: string;
  now?: () => number;
  requestId?: () => string;
}

/** Durable local intent only; workspace and message delivery remain native-owned. */
export class FirstMessageOutbox {
  private entries: readonly FirstMessageOutboxEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly flushing = new Map<string, Promise<void>>();
  private writes: Promise<void> = Promise.resolve();
  private hydration: Promise<void> | null = null;
  private readonly storageKey: string;

  constructor(private readonly options: FirstMessageOutboxOptions) {
    this.storageKey = options.storageKey ?? FIRST_MESSAGE_OUTBOX_STORAGE_KEY;
  }

  hydrate(): Promise<void> {
    if (!this.hydration) this.hydration = this.readStorage();
    return this.hydration;
  }

  private async readStorage(): Promise<void> {
    const stored = await this.options.storage.getItem(this.storageKey);
    if (stored !== null) {
      const parsed = FirstMessageOutboxStorageSchema.parse(JSON.parse(stored));
      for (const entry of parsed.entries) {
        if (entry.status !== "sending") continue;
        entry.status = "unknown";
        entry.error = "正在核对上次发送结果";
      }
      this.entries = parsed.entries;
    }
    this.emit();
  }

  getSnapshot = (): readonly FirstMessageOutboxEntry[] => this.entries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async enqueue(input: FirstMessageOutboxInput): Promise<FirstMessageOutboxEntry> {
    await this.hydrate();
    const validated = FirstMessageOutboxInputSchema.parse(input);
    let enqueued!: FirstMessageOutboxEntry;
    await this.write((entries) => {
      const existing = entries.find((entry) => entry.id === validated.id);
      if (existing) {
        const previous = FirstMessageOutboxInputSchema.parse(existing);
        if (JSON.stringify(previous) !== JSON.stringify(validated)) {
          throw new Error("待发送项已存在，不能替换其首消息或目标主机");
        }
        enqueued = existing;
        return entries;
      }
      const requestId = this.options.requestId?.() ?? crypto.randomUUID();
      enqueued = {
        ...validated,
        requestId,
        clientMessageId: requestId + ":initial-message",
        createdAt: this.options.now?.() ?? Date.now(),
        status: "queued",
        submitted: false,
        replayBlocked: false,
        error: null,
        result: null,
      };
      return [...entries, enqueued];
    });
    return enqueued;
  }

  async retry(id: string): Promise<void> {
    await this.hydrate();
    await this.write((entries) =>
      entries.map((entry) => {
        if (entry.id !== id || entry.status === "sent" || entry.status === "sending") return entry;
        return { ...entry, status: "queued", error: null };
      }),
    );
  }

  async removeSent(id: string): Promise<void> {
    await this.hydrate();
    await this.write((entries) =>
      entries.filter((entry) => entry.id !== id || entry.status !== "sent"),
    );
  }

  async failUnsubmittedHost(hostId: string, message: string): Promise<void> {
    await this.hydrate();
    if (
      !this.entries.some(
        (entry) => entry.hostId === hostId && !entry.submitted && entry.status === "queued",
      )
    )
      return;
    await this.write((entries) =>
      entries.map((entry) => {
        if (entry.hostId !== hostId || entry.submitted || entry.status !== "queued") return entry;
        return { ...entry, status: "failed", error: message };
      }),
    );
  }

  flushHost(hostId: string, port: FirstMessageOutboxPort): Promise<void> {
    const previous = this.flushing.get(hostId);
    if (previous) return previous;
    const pending = this.runHost(hostId, port);
    this.flushing.set(hostId, pending);
    const release = () => this.flushing.delete(hostId);
    void pending.then(release, release);
    return pending;
  }

  private async runHost(hostId: string, port: FirstMessageOutboxPort): Promise<void> {
    await this.hydrate();
    const pending = this.entries.filter((entry) => {
      const shouldSend =
        entry.status === "queued" || entry.status === "unknown" || entry.status === "sending";
      return entry.hostId === hostId && shouldSend;
    });
    for (const entry of pending) await this.deliver(entry, port);
  }

  private async deliver(
    entry: FirstMessageOutboxEntry,
    port: FirstMessageOutboxPort,
  ): Promise<void> {
    if (entry.submitted) {
      let snapshot: CreationSnapshot | null;
      try {
        snapshot = await port.getCreation(entry.requestId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "请检查主机连接";
        await this.patch(entry.id, {
          status: "unknown",
          error: "无法核对上次发送结果，内容已保留：" + reason,
        });
        return;
      }
      if (snapshot) {
        await this.applyCreation(entry, snapshot);
        return;
      }
      if (entry.replayBlocked) {
        await this.patch(entry.id, {
          status: "unknown",
          error: "上次创建存在终止回执，需在主机确认结果，内容已保留",
        });
        return;
      }
    }

    let prepared: PreparedFirstMessageAttachments;
    try {
      prepared = await port.prepareAttachments(entry);
    } catch {
      await this.patch(entry.id, {
        status: "failed",
        error: "附件准备失败，正文和附件引用已保留，请重试",
      });
      return;
    }
    // This write must complete before the daemon receives any creation request.
    await this.patch(entry.id, { status: "sending", submitted: true, error: null });
    let result: WorkspaceCreateResponse["payload"];
    try {
      result = await port.createWorkspace({
        source: entry.source,
        idempotencyKey: entry.requestId,
        requestId: entry.requestId,
        firstAgentContext: { prompt: entry.text, attachments: prepared.attachments ?? [] },
        taskConversation: {
          idempotencyKey: entry.requestId,
          ownerPluginId: "vibe-board",
          initialRecipient: {
            role: "planner",
            presetId: entry.plannerPresetId,
            config: entry.config,
          },
          initialMessage: {
            text: entry.text,
            clientMessageId: entry.clientMessageId,
            ...prepared,
          },
        },
      });
    } catch {
      await this.patch(entry.id, {
        status: "unknown",
        error: "发送结果尚不明确，联网后会先核对回执",
      });
      return;
    }
    if (result.creation) {
      await this.applyCreation(entry, result.creation);
      return;
    }
    await this.patch(entry.id, {
      status: "failed",
      replayBlocked: true,
      error: "创建或首消息发送失败，内容已保留：" + (result.error ?? "缺少正式回执"),
    });
  }

  private async applyCreation(
    entry: FirstMessageOutboxEntry,
    snapshot: CreationSnapshot,
  ): Promise<void> {
    const matches = snapshot.kind === "workspace" && snapshot.idempotencyKey === entry.requestId;
    if (!matches) {
      await this.patch(entry.id, {
        status: "unknown",
        replayBlocked: true,
        error: "回执与待发送项不一致，已停止自动提交",
      });
      return;
    }
    if (
      snapshot.phase === "completed" &&
      snapshot.workspaceId &&
      snapshot.agentId &&
      snapshot.conversationId &&
      snapshot.memberId
    ) {
      await this.patch(entry.id, {
        status: "sent",
        error: null,
        result: {
          workspaceId: snapshot.workspaceId,
          agentId: snapshot.agentId,
          conversationId: snapshot.conversationId,
          memberId: snapshot.memberId,
        },
      });
      return;
    }
    if (snapshot.phase === "completed") {
      await this.patch(entry.id, {
        status: "failed",
        replayBlocked: true,
        error: "创建回执缺少任务群聊或规划成员，请升级主机并核对原会话；正文和附件已保留",
      });
      return;
    }
    if (snapshot.phase === "failed") {
      const status = snapshot.outcomeUnknown ? "unknown" : "failed";
      await this.patch(entry.id, {
        status,
        replayBlocked: true,
        error: "原生创建未完成，内容已保留：" + (snapshot.error ?? "请检查主机上的会话状态"),
      });
      return;
    }
    await this.patch(entry.id, { status: "unknown", error: "主机正在创建会话，等待正式回执" });
  }

  private patch(id: string, patch: Partial<FirstMessageOutboxEntry>): Promise<void> {
    return this.write((entries) =>
      entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    );
  }

  private write(
    update: (entries: readonly FirstMessageOutboxEntry[]) => readonly FirstMessageOutboxEntry[],
  ): Promise<void> {
    const written = this.writes.then(async () => {
      const entries = update(this.entries);
      await this.options.storage.setItem(this.storageKey, JSON.stringify({ version: 1, entries }));
      this.entries = entries;
      this.emit();
      return undefined;
    });
    this.writes = written.catch(() => undefined);
    return written;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
