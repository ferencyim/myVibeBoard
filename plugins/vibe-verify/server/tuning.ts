// Verification parameters the owner can change (settings, WP-99). Modules read them through a
// `() => VerifyTuning` accessor on every use, so a change applies without a restart.

import type { Judgement } from "./vibe/contract";
import type { VerifySettingsValues } from "../shared/settings";
import type { IssueSeverity } from "./review";

export interface VerifyTuning {
  autoReturnOnFail: boolean;
  maxReviewReturns: number;
  severityMap: Record<IssueSeverity, Judgement>;
  preferDifferentProvider: boolean;
  roundTimeoutMs: number;
  excerptChars: number;
  readyTimeoutMs: number;
  /** "" = use the plugin's own default root. */
  worktreeRoot: string;
}

/** The values that used to be hard-coded (also the settings defaults). */
export const DEFAULT_TUNING: VerifyTuning = {
  autoReturnOnFail: true,
  maxReviewReturns: 3,
  severityMap: { severe: "fail", major: "doubt", minor: "doubt" },
  preferDifferentProvider: true,
  roundTimeoutMs: 20 * 60_000,
  excerptChars: 6_000,
  readyTimeoutMs: 60_000,
  worktreeRoot: "",
};

export function tuningOf(s: VerifySettingsValues, env: NodeJS.ProcessEnv = process.env): VerifyTuning {
  return {
    autoReturnOnFail: s.autoReturnOnFail,
    // COMPAT(env-review-max-returns): the env var is the initial value while the setting is unset.
    maxReviewReturns: s.maxReviewReturns ?? (Number(env.VIBE_REVIEW_MAX_RETURNS) || DEFAULT_TUNING.maxReviewReturns),
    severityMap: { severe: s.severitySevere, major: s.severityMajor, minor: s.severityMinor },
    preferDifferentProvider: s.preferDifferentProvider,
    roundTimeoutMs: s.roundTimeoutMinutes * 60_000,
    excerptChars: s.excerptChars,
    readyTimeoutMs: s.readyTimeoutSeconds * 1000,
    worktreeRoot: s.worktreeRoot.trim(),
  };
}

export type TuningSource = () => VerifyTuning;
export const defaultTuning: TuningSource = () => DEFAULT_TUNING;
