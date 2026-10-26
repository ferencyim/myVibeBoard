import { promises as fs } from "node:fs";
import type pino from "pino";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import {
  comparePromptLibraryEntries,
  normalizePromptLibraryTag,
  normalizePromptLibraryTags,
  PROMPT_LIBRARY_MAX_CLOCK_SKEW_MS,
  promptLibraryTagKey,
  promptLibraryTombstone,
  removePromptLibraryTag,
  renamePromptLibraryTag,
} from "@getpaseo/protocol/prompt-library";
import { PromptLibraryEntrySchema } from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";

export class PromptLibraryError extends Error {
  constructor(
    public readonly code: "prompt_library_invalid" | "prompt_library_tag_empty",
    message: string,
  ) {
    super(message);
    this.name = "PromptLibraryError";
  }
}

export interface PromptLibraryMutationResult {
  entry: PromptLibraryEntry;
  applied: boolean;
}

export class PromptLibraryStore {
  private entries = new Map<string, PromptLibraryEntry>();
  private loaded = false;
  private initializing: Promise<void> | null = null;
  private operations: Promise<void> = Promise.resolve();
  private lastTimestampMs = 0;

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
    private readonly writeFile: (
      path: string,
      value: unknown,
    ) => Promise<void> = writeJsonFileAtomic,
    private readonly logger?: pino.Logger,
  ) {}

  async initialize(): Promise<void> {
    if (this.loaded) return;
    if (!this.initializing) {
      this.initializing = this.load().finally(() => {
        this.initializing = null;
      });
    }
    await this.initializing;
  }

  async list(): Promise<PromptLibraryEntry[]> {
    return this.exclusive(async () => {
      await this.initialize();
      return [...this.entries.values()].map(cloneEntry);
    });
  }

  async upsert(input: PromptLibraryEntry): Promise<PromptLibraryMutationResult> {
    return this.exclusive(async () => {
      await this.initialize();
      const entry = this.clampUpdatedAt(normalizeEntry(input));
      const existing = this.entries.get(entry.id);
      if (existing && comparePromptLibraryEntries(entry, existing) < 0) {
        return { entry: cloneEntry(existing), applied: false };
      }
      this.store(entry);
      await this.persist();
      return { entry: cloneEntry(entry), applied: true };
    });
  }

  async delete(input: { id: string; updatedAt: string }): Promise<PromptLibraryMutationResult> {
    return this.exclusive(async () => {
      await this.initialize();
      const tombstone = this.clampUpdatedAt(promptLibraryTombstone(input));
      const existing = this.entries.get(tombstone.id);
      if (existing && comparePromptLibraryEntries(tombstone, existing) < 0) {
        return { entry: cloneEntry(existing), applied: false };
      }
      this.store(tombstone);
      await this.persist();
      return { entry: cloneEntry(tombstone), applied: true };
    });
  }

  async renameTag(input: {
    from: string;
    to: string;
  }): Promise<{ entries: PromptLibraryEntry[]; affectedCount: number }> {
    return this.exclusive(async () => {
      await this.initialize();
      const from = normalizeRequiredTag(input.from);
      const to = normalizeRequiredTag(input.to);
      const fromKey = promptLibraryTagKey(from);
      const changed: PromptLibraryEntry[] = [];
      const updatedAt = this.nextTimestamp();
      for (const entry of this.entries.values()) {
        if (entry.deleted) continue;
        if (!entry.tags.some((tag) => promptLibraryTagKey(tag) === fromKey)) continue;
        const tags = renamePromptLibraryTag(entry.tags, from, to);
        if (sameTags(entry.tags, tags)) continue;
        const next = { ...entry, tags, updatedAt };
        this.store(next);
        changed.push(next);
      }
      if (changed.length > 0) await this.persist();
      return { entries: changed.map(cloneEntry), affectedCount: changed.length };
    });
  }

  async deleteTag(input: {
    tag: string;
  }): Promise<{ entries: PromptLibraryEntry[]; affectedCount: number }> {
    return this.exclusive(async () => {
      await this.initialize();
      const tag = normalizeRequiredTag(input.tag);
      const key = promptLibraryTagKey(tag);
      const changed: PromptLibraryEntry[] = [];
      const updatedAt = this.nextTimestamp();
      for (const entry of this.entries.values()) {
        if (entry.deleted) continue;
        if (!entry.tags.some((candidate) => promptLibraryTagKey(candidate) === key)) continue;
        const next = { ...entry, tags: removePromptLibraryTag(entry.tags, tag), updatedAt };
        this.store(next);
        changed.push(next);
      }
      if (changed.length > 0) await this.persist();
      return { entries: changed.map(cloneEntry), affectedCount: changed.length };
    });
  }

  private async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== null) await this.loadFromRaw(raw);
    this.loaded = true;
  }

  private async loadFromRaw(raw: string): Promise<void> {
    const rawEntries = parseEntryList(raw);
    if (!rawEntries) {
      await this.quarantineCorruptFile();
      return;
    }
    for (const candidate of rawEntries) {
      const entry = parseStoredEntry(candidate);
      if (!entry) {
        this.logger?.error({ filePath: this.filePath }, "Skipping invalid prompt library entry");
        continue;
      }
      const existing = this.entries.get(entry.id);
      if (!existing || comparePromptLibraryEntries(entry, existing) >= 0) this.store(entry);
    }
  }

  /** Keep the unreadable file for manual recovery and start with an empty library. */
  private async quarantineCorruptFile(): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${this.now().getTime()}`;
    try {
      await fs.rename(this.filePath, backupPath);
      this.logger?.error(
        { filePath: this.filePath, backupPath },
        "Prompt library file is corrupt; moved aside and starting empty",
      );
    } catch (err) {
      this.logger?.error({ err, filePath: this.filePath }, "Failed to move corrupt prompt library");
    }
  }

  private store(entry: PromptLibraryEntry): void {
    this.entries.set(entry.id, entry);
    this.lastTimestampMs = Math.max(this.lastTimestampMs, timestampMs(entry.updatedAt));
  }

  /** A device with a wrong clock cannot pin an entry in the far future. */
  private clampUpdatedAt(entry: PromptLibraryEntry): PromptLibraryEntry {
    const limit = this.now().getTime() + PROMPT_LIBRARY_MAX_CLOCK_SKEW_MS;
    if (timestampMs(entry.updatedAt) <= limit) return entry;
    return { ...entry, updatedAt: new Date(limit).toISOString() };
  }

  private async persist(): Promise<void> {
    await this.writeFile(this.filePath, { entries: [...this.entries.values()] });
  }

  private nextTimestamp(): string {
    const nowMs = this.now().getTime();
    const nextMs = Math.max(nowMs, this.lastTimestampMs + 1);
    this.lastTimestampMs = nextMs;
    return new Date(nextMs).toISOString();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function parseEntryList(raw: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
}

function parseStoredEntry(candidate: unknown): PromptLibraryEntry | null {
  const parsed = PromptLibraryEntrySchema.safeParse(candidate);
  if (!parsed.success) return null;
  try {
    return normalizeEntry(parsed.data);
  } catch {
    return null;
  }
}

function normalizeEntry(entry: PromptLibraryEntry): PromptLibraryEntry {
  if (entry.deleted) return promptLibraryTombstone(entry);
  const title = entry.title.trim();
  const body = entry.body;
  if (!entry.deleted) {
    if (title.length === 0) {
      throw new PromptLibraryError("prompt_library_invalid", "Prompt title cannot be empty");
    }
    if (body.trim().length === 0) {
      throw new PromptLibraryError("prompt_library_invalid", "Prompt body cannot be empty");
    }
  }
  return {
    id: entry.id.trim(),
    title,
    body,
    tags: normalizePromptLibraryTags(entry.tags),
    updatedAt: entry.updatedAt,
    deleted: entry.deleted,
  };
}

function normalizeRequiredTag(raw: string): string {
  const tag = normalizePromptLibraryTag(raw);
  if (tag.length === 0) {
    throw new PromptLibraryError("prompt_library_tag_empty", "Tag cannot be empty");
  }
  return tag;
}

function cloneEntry(entry: PromptLibraryEntry): PromptLibraryEntry {
  return { ...entry, tags: [...entry.tags] };
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
