import { LocalReplica } from "./replica";
import { openVibeDb } from "./open-db";

const replicas = new Map<string, LocalReplica | null>();

/** The host's local replica, or null where the platform has no local database (web, desktop). */
export function getLocalReplica(serverId: string): LocalReplica | null {
  if (!replicas.has(serverId)) {
    let replica: LocalReplica | null = null;
    try {
      const db = openVibeDb(serverId);
      replica = db ? LocalReplica.open(db) : null;
    } catch (error) {
      console.warn(`[Vibe] Local board database unavailable for ${serverId}`, error);
    }
    replicas.set(serverId, replica);
  }
  return replicas.get(serverId) ?? null;
}
