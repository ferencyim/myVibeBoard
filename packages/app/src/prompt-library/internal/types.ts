import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";

export interface PromptLibraryListResult {
  entries: PromptLibraryEntry[];
}

export interface PromptLibraryMutationResult {
  entry: PromptLibraryEntry;
  applied: boolean;
}

export interface PromptLibraryTagResult {
  entries: PromptLibraryEntry[];
  affectedCount: number;
}

/** The subset of `DaemonClient` the library needs. */
export interface PromptLibraryRemote {
  listPromptLibrary(): Promise<PromptLibraryListResult>;
  upsertPromptLibrary(options: { entry: PromptLibraryEntry }): Promise<PromptLibraryMutationResult>;
  deletePromptLibrary(options: {
    id: string;
    updatedAt: string;
  }): Promise<PromptLibraryMutationResult>;
  renamePromptLibraryTag(options: { from: string; to: string }): Promise<PromptLibraryTagResult>;
  deletePromptLibraryTag(options: { tag: string }): Promise<PromptLibraryTagResult>;
}

export interface PromptLibraryStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type PromptLibraryHostStatus =
  | "idle"
  | "loading"
  | "online"
  | "offline"
  | "unsupported"
  | "error";

/**
 * A visible, dismissible message about something sync did on its own: a local edit that lost to a
 * newer version on the host, or an edit the host refused and the replica rolled back.
 */
export type PromptLibraryNotice = "overridden" | "rejected";

export interface PromptLibraryHostSnapshot {
  serverId: string;
  entries: PromptLibraryEntry[];
  tags: string[];
  pendingCount: number;
  status: PromptLibraryHostStatus;
  error: string | null;
  notice: PromptLibraryNotice | null;
  hydrated: boolean;
}
