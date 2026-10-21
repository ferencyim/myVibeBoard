// Automation parameters the owner can change (settings, "advanced" group). Modules read them
// through a `() => MasterTuning` accessor on every use, so a change applies without a restart.

import type { MasterSettings } from "../shared/rpc";

export interface MasterTuning {
  askTimeoutMs: number;
  planTurnTimeoutMs: number;
  scoutTimeoutMs: number;
  maxResearchRounds: number;
  maxPlanLoops: number;
  jsonRepairRetries: number;
  proposalWindowMs: number;
  sweepDoneWindowMs: number;
  alertCooldownMs: { quotaLow: number; urgent: number; routine: number };
  projectBlockCardLimit: number;
  handoffMaxChars: number;
  handoffRecentDays: number;
}

const MIN = 60_000;

/** The built-in values (also the settings defaults). */
export const DEFAULT_TUNING: MasterTuning = {
  askTimeoutMs: 5 * MIN,
  planTurnTimeoutMs: 10 * MIN,
  scoutTimeoutMs: 5 * MIN,
  maxResearchRounds: 2,
  maxPlanLoops: 10,
  jsonRepairRetries: 1,
  proposalWindowMs: 15_000,
  sweepDoneWindowMs: 48 * 60 * MIN,
  alertCooldownMs: { quotaLow: 6 * 60 * MIN, urgent: 10 * MIN, routine: 60 * MIN },
  projectBlockCardLimit: 40,
  handoffMaxChars: 3500,
  handoffRecentDays: 7,
};

export function tuningOf(s: MasterSettings): MasterTuning {
  return {
    askTimeoutMs: s.askTimeoutMinutes * MIN,
    planTurnTimeoutMs: s.planTurnTimeoutMinutes * MIN,
    scoutTimeoutMs: s.scoutTimeoutMinutes * MIN,
    maxResearchRounds: s.maxResearchRounds,
    maxPlanLoops: s.maxPlanLoops,
    jsonRepairRetries: s.jsonRepairRetries,
    proposalWindowMs: s.proposalWindowSeconds * 1000,
    sweepDoneWindowMs: s.sweepDoneWindowHours * 60 * MIN,
    alertCooldownMs: {
      quotaLow: s.alertCooldownQuotaLowMinutes * MIN,
      urgent: s.alertCooldownUrgentMinutes * MIN,
      routine: s.alertCooldownRoutineMinutes * MIN,
    },
    projectBlockCardLimit: s.projectBlockCardLimit,
    handoffMaxChars: s.handoffMaxChars,
    handoffRecentDays: s.handoffRecentDays,
  };
}

export type TuningSource = () => MasterTuning;
export const defaultTuning: TuningSource = () => DEFAULT_TUNING;
