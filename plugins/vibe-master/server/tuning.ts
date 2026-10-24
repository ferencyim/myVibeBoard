// Automation parameters the owner can change (settings, "advanced" group). Modules read them
// through a `() => MasterTuning` accessor on every use, so a change applies without a restart.

import type { MasterSettings } from "../shared/rpc";

export interface MasterTuning {
  askTimeoutMs: number;
  jsonRepairRetries: number;
  alertCooldownMs: { quotaLow: number; urgent: number; routine: number };
  handoffMaxChars: number;
  handoffRecentDays: number;
}

const MIN = 60_000;

/** The built-in values (also the settings defaults). */
export const DEFAULT_TUNING: MasterTuning = {
  askTimeoutMs: 5 * MIN,
  jsonRepairRetries: 1,
  alertCooldownMs: { quotaLow: 6 * 60 * MIN, urgent: 10 * MIN, routine: 60 * MIN },
  handoffMaxChars: 3500,
  handoffRecentDays: 7,
};

export function tuningOf(s: MasterSettings): MasterTuning {
  return {
    askTimeoutMs: s.askTimeoutMinutes * MIN,
    jsonRepairRetries: s.jsonRepairRetries,
    alertCooldownMs: {
      quotaLow: s.alertCooldownQuotaLowMinutes * MIN,
      urgent: s.alertCooldownUrgentMinutes * MIN,
      routine: s.alertCooldownRoutineMinutes * MIN,
    },
    handoffMaxChars: s.handoffMaxChars,
    handoffRecentDays: s.handoffRecentDays,
  };
}

export type TuningSource = () => MasterTuning;
export const defaultTuning: TuningSource = () => DEFAULT_TUNING;
