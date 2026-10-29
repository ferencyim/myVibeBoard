// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// WP-109: the master agent decides which waiting todo card goes next (switch on the master settings
// page). vibe-master publishes its availability here; vibe-scheduler reads it on every tick and
// talks to the master through three bus events (see events.ts), so neither plugin calls the other.

import { z } from "zod";

/** vibe_meta key under which vibe-master publishes its dispatch mode (JSON, MasterDispatchMode). */
export const MASTER_DISPATCH_KEY = "master.dispatch";

export const MasterDispatchModeSchema = z.object({
  /** The owner switched "master dispatch" on. */
  enabled: z.boolean(),
  /** The master can answer now (a preset is chosen, the master is enabled). */
  available: z.boolean(),
  /** Why it cannot (shown on the card when the scheduler dispatches by its own rules instead). */
  reason: z.string(),
  /** How long the master gets to answer one request; the scheduler waits a little longer. */
  timeoutSeconds: z.number().int().min(10),
});
export type MasterDispatchMode = z.infer<typeof MasterDispatchModeSchema>;

/** Until vibe-master published anything: the scheduler dispatches by its own rules. */
export const DEFAULT_MASTER_DISPATCH: MasterDispatchMode = {
  enabled: false,
  available: false,
  reason: "",
  timeoutSeconds: 120,
};
