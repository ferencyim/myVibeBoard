// One-time move of the prompts the owner edited in the old settings page (WP-93) into global
// overrides of the prompt registry (WP-98).
//
// COMPAT(prompt-registry): added 2026-10-21, remove after 2027-04-01 (together with the four
// legacy keys in shared/rpc.ts). The legacy keys stay readable but are never read again after
// the first run; the marker lives in vibe_meta, next to the overrides it protects.

import type { MasterSettings } from "../../shared/rpc";
import type { VibeDb, VibeStore } from "../vibe/db";

const MARKER = "prompt_migrated:vibe-master";

/** legacy setting -> prompt key */
export const LEGACY_PROMPT_KEYS = {
  rulesSupplement: "master.rules_supplement",
  templateCardDone: "master.wake.card_done",
} as const;

/**
 * Copies non-blank legacy values to global overrides (never over an override that already exists)
 * and records that it ran. Returns the prompt keys that were migrated.
 */
export function migrateLegacyPromptSettings(
  db: VibeDb,
  store: VibeStore,
  settings: Pick<MasterSettings, keyof typeof LEGACY_PROMPT_KEYS>,
): string[] {
  if (db.prepare("SELECT 1 AS x FROM vibe_meta WHERE key = ?").get(MARKER)) return [];
  const migrated: string[] = [];
  db.immediate(() => {
    for (const [setting, key] of Object.entries(LEGACY_PROMPT_KEYS)) {
      const text = settings[setting as keyof typeof LEGACY_PROMPT_KEYS] ?? "";
      if (!text.trim()) continue;
      if (store.prompts.list().find((p) => p.key === key)?.globalOverride) continue;
      store.prompts.setOverride(key, text);
      migrated.push(key);
    }
    db.prepare("INSERT OR IGNORE INTO vibe_meta (key, value) VALUES (?, ?)").run(
      MARKER,
      new Date().toISOString(),
    );
  });
  return migrated;
}
