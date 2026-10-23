import type { VibeDb } from "../vibe/db";
import { setContextMeta } from "../vibe/db/context-state";
import { compactionSettings } from "./settings";
import { DEFAULT_TTL_SECONDS } from "./policy";
import type { CompactionConfig } from "./scheduler";

/** Read-only cache estimates for the task panel; settings remain owned by vibe-context. */
export function persistCachePolicy(db: Pick<VibeDb, "prepare">, config: CompactionConfig): void {
  const values = compactionSettings.schema.parse(config);
  const policy = {
    enabled: values.enabled,
    ttlSeconds: { ...DEFAULT_TTL_SECONDS, ...values.ttlSeconds },
    fallbackTtlSeconds: values.fallbackTtlSeconds,
    marginSeconds: values.marginSeconds,
    marginLongFromSeconds: values.marginLongFromSeconds,
    marginLongSeconds: values.marginLongSeconds,
    marginShortSeconds: values.marginShortSeconds,
  };
  setContextMeta(db, "context:compaction_policy", JSON.stringify(policy));
}
