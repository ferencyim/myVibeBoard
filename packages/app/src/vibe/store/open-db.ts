import type { VibeSqlDb } from "./sql";

/** Web / desktop: the board stays online-only, there is no local database. */
export function openVibeDb(_serverId: string): VibeSqlDb | null {
  return null;
}
