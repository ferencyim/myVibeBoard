import type { PromptLibraryEntry } from "@getpaseo/protocol/prompt-library";
import { PromptLibraryEntrySchema } from "@getpaseo/protocol/messages";
import type { PromptLibraryStorage } from "./types";

export const PROMPT_LIBRARY_STORAGE_PREFIX = "paseo:prompt-library:v1:";

export interface PromptLibraryCache {
  entries: PromptLibraryEntry[];
  pending: PromptLibraryEntry[];
}

export function promptLibraryStorageKey(serverId: string): string {
  return `${PROMPT_LIBRARY_STORAGE_PREFIX}${encodeURIComponent(serverId)}`;
}

/**
 * Reads the replica. A storage failure throws, so the caller never mistakes "could not read" for
 * "empty" and overwrites the offline queue. Unparseable content, or any dropped entry, is first
 * copied to a backup key so nothing the user wrote is lost when the replica is rebuilt.
 */
export async function readPromptLibraryCache(
  storage: PromptLibraryStorage,
  serverId: string,
  now: () => number = Date.now,
): Promise<PromptLibraryCache | null> {
  const key = promptLibraryStorageKey(serverId);
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  const decoded = decodeCache(raw);
  if (!decoded.cache || decoded.dropped > 0) {
    await storage.setItem(`${key}:corrupt-${now()}`, raw);
  }
  return decoded.cache;
}

function decodeCache(raw: string): { cache: PromptLibraryCache | null; dropped: number } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { cache: null, dropped: 0 };
  }
  const record = value as { entries?: unknown; pending?: unknown } | null;
  if (!Array.isArray(record?.entries) || !Array.isArray(record?.pending)) {
    return { cache: null, dropped: 0 };
  }
  const entries = parseEntries(record.entries);
  const pending = parseEntries(record.pending);
  return {
    cache: { entries: entries.valid, pending: pending.valid },
    dropped: entries.dropped + pending.dropped,
  };
}

function parseEntries(items: readonly unknown[]): { valid: PromptLibraryEntry[]; dropped: number } {
  const valid: PromptLibraryEntry[] = [];
  for (const item of items) {
    const parsed = PromptLibraryEntrySchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
  }
  return { valid, dropped: items.length - valid.length };
}

export async function writePromptLibraryCache(
  storage: PromptLibraryStorage,
  serverId: string,
  cache: PromptLibraryCache,
): Promise<void> {
  await storage.setItem(promptLibraryStorageKey(serverId), JSON.stringify(cache));
}
