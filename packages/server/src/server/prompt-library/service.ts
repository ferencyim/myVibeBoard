import path from "node:path";
import type pino from "pino";
import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { PromptLibraryStore, type PromptLibraryMutationResult } from "./store.js";

export { PromptLibraryError, type PromptLibraryMutationResult } from "./store.js";

export class PromptLibraryService {
  constructor(private readonly store: PromptLibraryStore) {}

  initialize(): Promise<void> {
    return this.store.initialize();
  }

  async list(): Promise<{ entries: PromptLibraryEntry[] }> {
    return { entries: await this.store.list() };
  }

  upsert(entry: PromptLibraryEntry): Promise<PromptLibraryMutationResult> {
    return this.store.upsert(entry);
  }

  delete(input: { id: string; updatedAt: string }): Promise<PromptLibraryMutationResult> {
    return this.store.delete(input);
  }

  renameTag(input: {
    from: string;
    to: string;
  }): Promise<{ entries: PromptLibraryEntry[]; affectedCount: number }> {
    return this.store.renameTag(input);
  }

  deleteTag(input: {
    tag: string;
  }): Promise<{ entries: PromptLibraryEntry[]; affectedCount: number }> {
    return this.store.deleteTag(input);
  }
}

export interface CreatePromptLibraryServiceOptions {
  paseoHome: string;
  now?: () => Date;
  logger?: pino.Logger;
}

export function createPromptLibraryService(
  options: CreatePromptLibraryServiceOptions,
): PromptLibraryService {
  return new PromptLibraryService(
    new PromptLibraryStore(
      path.join(options.paseoHome, "prompt-library.json"),
      options.now,
      undefined,
      options.logger?.child({ component: "prompt-library" }),
    ),
  );
}
