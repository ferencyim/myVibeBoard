// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
import { z } from "zod";

export const PROJECT_TYPES = [
  "android",
  "ios",
  "web",
  "desktop",
  "backend",
  "embedded",
  "other",
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];
export const ProjectTypeSchema = z.enum(PROJECT_TYPES);

/** Purpose of a preset: which jobs the selector may use it for ("planner" WP-105, "verifier" WP-108). */
export const ROLE_HINTS = ["worker", "scout", "reviewer", "planner", "verifier"] as const;
export type RoleHint = (typeof ROLE_HINTS)[number];
export const RoleHintSchema = z.enum(ROLE_HINTS);

/** Project requirements file default: relative to the repository root. */
export const DEFAULT_REQUIREMENTS_PATH = "PRODUCT-REQUIREMENTS.md";

// --- presets (field values kept compatible with the Tasks plugin) ------------------------
export const PRESET_ENVIRONMENT_KINDS = ["project-default", "new-worktree"] as const;
export type PresetEnvironmentKind = (typeof PRESET_ENVIRONMENT_KINDS)[number];
export const PresetEnvironmentKindSchema = z.enum(PRESET_ENVIRONMENT_KINDS);

export const PRESET_PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;
export type PresetPermissionMode = (typeof PRESET_PERMISSION_MODES)[number];
export const PresetPermissionModeSchema = z.enum(PRESET_PERMISSION_MODES);

// --- agent sessions --------------------------------------------------------------------
/** `worker` is a card's (main) executing agent; `subagent` runs one subtask of it (WP-106). */
export const SESSION_ROLES = [
  "master",
  "scout",
  "planner",
  "plan_reviewer",
  "worker",
  "subagent",
  "reviewer",
  "verifier",
] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export const SessionRoleSchema = z.enum(SESSION_ROLES);

export const SESSION_STATES = ["starting", "working", "waiting", "idle", "ended", "error"] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const SessionStateSchema = z.enum(SESSION_STATES);

/** Task complexity as judged by the scout / scheduler (round 2: complexity policy). */
export const SESSION_COMPLEXITIES = ["short", "multi", "long"] as const;
export type SessionComplexity = (typeof SESSION_COMPLEXITIES)[number];
export const SessionComplexitySchema = z.enum(SESSION_COMPLEXITIES);

// --- verification ----------------------------------------------------------------------
export const JUDGEMENTS = ["pass", "doubt", "fail"] as const;
export type Judgement = (typeof JUDGEMENTS)[number];
export const JudgementSchema = z.enum(JUDGEMENTS);

/** `check` = acceptance-check verification (default); `review` = model code review. */
export const VERIFICATION_KINDS = ["check", "review"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];
export const VerificationKindSchema = z.enum(VERIFICATION_KINDS);

export const REVIEW_VERDICTS = ["pass", "issues", "severe"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);

export const VERIFICATION_MODES = ["evidence", "tests_only"] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];
export const VerificationModeSchema = z.enum(VERIFICATION_MODES);

export const EVIDENCE_KINDS = ["screenshot", "gif", "video", "log", "report", "photo"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

// --- devices / maintenance -------------------------------------------------------------
export const DEVICE_KINDS = [
  "emulator",
  "simulator",
  "board",
  "debugger",
  "camera",
  "other",
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DeviceKindSchema = z.enum(DEVICE_KINDS);

export const MAINTENANCE_TRIGGER_KINDS = ["workload", "time", "event"] as const;
export type MaintenanceTriggerKind = (typeof MAINTENANCE_TRIGGER_KINDS)[number];
export const MaintenanceTriggerKindSchema = z.enum(MAINTENANCE_TRIGGER_KINDS);

export const MAINTENANCE_OUTPUT_MODES = ["suggest", "fix"] as const;
export type MaintenanceOutputMode = (typeof MAINTENANCE_OUTPUT_MODES)[number];
export const MaintenanceOutputModeSchema = z.enum(MAINTENANCE_OUTPUT_MODES);

export const MAINTENANCE_RUN_STATUSES = ["running", "done", "skipped", "failed"] as const;
export type MaintenanceRunStatus = (typeof MAINTENANCE_RUN_STATUSES)[number];
export const MaintenanceRunStatusSchema = z.enum(MAINTENANCE_RUN_STATUSES);

export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
