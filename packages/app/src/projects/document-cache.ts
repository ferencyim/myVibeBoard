import { z } from "zod";
const briefEdit = z.object({
  path: z.enum(["AGENTS.md", "CLAUDE.md"]),
  content: z.string(),
  baseRevision: z.string(),
});
export const projectDocumentCacheSchema = z.object({
  syncError: z.string().nullable().optional(),
  documents: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
      totalBytes: z.number(),
      truncated: z.boolean(),
      revision: z.string(),
      syncedAt: z.string(),
    }),
  ),
  pending: z.array(
    z.object({
      id: z.string(),
      documents: z.array(briefEdit),
      createdAt: z.string(),
      deliveredAt: z.string().nullable(),
    }),
  ),
});
export type DocumentSnapshot = z.infer<typeof projectDocumentCacheSchema>;
export type BriefDocumentEdit = z.infer<typeof briefEdit>;
export interface LocalBriefChange {
  id: string;
  documents: BriefDocumentEdit[];
  createdAt: string;
}
const cacheSchema = projectDocumentCacheSchema.extend({
  outbox: z.array(
    z.object({ id: z.string(), documents: z.array(briefEdit), createdAt: z.string() }),
  ),
});
export interface DocumentStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export class ProjectDocumentCache {
  private state: DocumentSnapshot & { outbox: LocalBriefChange[] } = {
    documents: [],
    pending: [],
    outbox: [],
  };
  private writes: Promise<void> = Promise.resolve();
  readonly key: string;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  constructor(
    private storage: DocumentStorage,
    serverId: string,
    projectId: string,
  ) {
    this.key =
      "project-documents:v1:" + encodeURIComponent(serverId) + ":" + encodeURIComponent(projectId);
  }
  async load() {
    const raw = await this.storage.getItem(this.key);
    if (raw) {
      const parsed = cacheSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.state = parsed.data;
    }
    return this.snapshot();
  }
  snapshot() {
    return this.state;
  }
  private update(change: (state: typeof this.state) => typeof this.state) {
    const previous = this.writes;
    const work = (async () => {
      await previous.catch(() => {});
      const next = change(this.state);
      await this.storage.setItem(this.key, JSON.stringify(next));
      this.state = next;
      for (const listener of this.listeners) listener();
    })();
    this.writes = work;
    return work.then(() => this.snapshot());
  }
  queue(change: LocalBriefChange) {
    return this.update((state) => ({ ...state, outbox: [...state.outbox, change] }));
  }
  syncFailed() {
    return this.update((state) => ({
      ...state,
      syncError: "项目文档同步未完成，已保留缓存与待合并修改；联网后自动重试。",
    }));
  }
  received(snapshot: DocumentSnapshot) {
    return this.update((state) => ({ ...snapshot, syncError: null, outbox: state.outbox }));
  }
  acknowledge(id: string, snapshot: DocumentSnapshot) {
    return this.update((state) => ({
      ...snapshot,
      outbox: state.outbox.filter((c) => c.id !== id),
    }));
  }
}
