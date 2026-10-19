// Offline cache of the plugin catalog: the last catalog an online session saw, restricted to the
// plugins that can work without the daemon, so a cold start in flight mode still opens the board.

import { VIBE_BOARD_PLUGIN_ID } from "./rpc/local-rpc";
import { getLocalReplica } from "./store/registry";

/** Plugins whose client code runs on local data when the host is unreachable. */
const OFFLINE_PLUGIN_IDS = new Set([VIBE_BOARD_PLUGIN_ID]);

interface CatalogEntry {
  id: string;
  clientBundle?: string | null;
}

/** FNV-1a over the bundle text plus its length: cheap "did anything change" check. */
function hashCatalog(entries: readonly CatalogEntry[]): string {
  const text = JSON.stringify(entries);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

/** Remember the offline-capable part of a freshly fetched catalog (rewritten only when it changed). */
export function saveOfflineCatalog(serverId: string, catalog: readonly CatalogEntry[]): void {
  const replica = getLocalReplica(serverId);
  if (!replica) return;
  const entries = catalog.filter((entry) => entry.clientBundle && OFFLINE_PLUGIN_IDS.has(entry.id));
  const hash = hashCatalog(entries);
  const saved = replica.db.all<{ hash: string }>(
    "SELECT hash FROM plugin_cache WHERE server_id = ?",
    [serverId],
  )[0];
  if (saved?.hash === hash) return;
  replica.db.run(
    `INSERT INTO plugin_cache (server_id, hash, catalog_json) VALUES (?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET hash = excluded.hash, catalog_json = excluded.catalog_json`,
    [serverId, hash, JSON.stringify(entries)],
  );
}

export function loadOfflineCatalog<T extends CatalogEntry>(serverId: string): T[] {
  const row = getLocalReplica(serverId)?.db.all<{ catalog_json: string }>(
    "SELECT catalog_json FROM plugin_cache WHERE server_id = ?",
    [serverId],
  )[0];
  if (!row) return [];
  try {
    return JSON.parse(row.catalog_json) as T[];
  } catch {
    return [];
  }
}
