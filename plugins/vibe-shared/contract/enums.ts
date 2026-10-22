import { z } from "zod";

// --- board -----------------------------------------------------------------------------
export const CARD_COLUMNS = ["draft", "todo", "in_progress", "verifying", "done"] as const;
export type CardColumn = (typeof CARD_COLUMNS)[number];
export const CardColumnSchema = z.enum(CARD_COLUMNS);

export const CARD_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];
export const CardPrioritySchema = z.enum(CARD_PRIORITIES);

export const CARD_ORIGINS = ["manual", "maintenance"] as const;
export type CardOrigin = (typeof CARD_ORIGINS)[number];
export const CardOriginSchema = z.enum(CARD_ORIGINS);

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

export const CARD_EVENT_TYPES = [
  "evaluation",
  "status",
  "switch_agent",
  "compaction",
  "reject",
  "note",
  "maintenance",
  // Group chat message (body: ChatEventBody) and the master's edit suggestion (ProposalEventBody).
  "chat",
  "proposal",
] as const;
export type CardEventType = (typeof CARD_EVENT_TYPES)[number];
export const CardEventTypeSchema = z.enum(CARD_EVENT_TYPES);

// `agent` is the legacy generic agent author (old rows); chat/proposal use the role-specific kinds.
export const AUTHOR_KINDS = [
  "user",
  "agent",
  "master",
  "executor",
  "reviewer",
  "scout",
  "system",
] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];
export const AuthorKindSchema = z.enum(AUTHOR_KINDS);

/** Purpose of a preset: which jobs the selector may use it for ("planner" WP-105, "verifier" WP-108). */
export const ROLE_HINTS = ["worker", "scout", "reviewer", "planner", "verifier"] as const;
export type RoleHint = (typeof ROLE_HINTS)[number];
export const RoleHintSchema = z.enum(ROLE_HINTS);

/** `chat` card event: what kind of message it is (UI styling / filtering). */
export const CHAT_KINDS = ["question", "summary", "verdict", "info"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];
export const ChatKindSchema = z.enum(CHAT_KINDS);

/** Which card conversation a `chat` event belongs to: plan / execution tab (WP-105), review tab (WP-108). */
export const CHAT_THREADS = ["plan", "exec", "review"] as const;
export type ChatThread = (typeof CHAT_THREADS)[number];
export const ChatThreadSchema = z.enum(CHAT_THREADS);

/** Card detail tabs that carry an unread marker (WP-105; "review" WP-108). */
export const UNREAD_TABS = ["plan", "exec", "review", "verify"] as const;
export type UnreadTab = (typeof UNREAD_TABS)[number];

export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected", "superseded"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);

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
export const SESSION_ROLES = ["master", "planner", "worker", "verifier", "subagent"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];
export const SessionRoleSchema = z.enum(SESSION_ROLES);

export const SESSION_STATES = ["starting", "working", "waiting", "idle", "ended", "error"] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const SessionStateSchema = z.enum(SESSION_STATES);

/** Runtime state of one subtask of a card's plan (WP-106); `waiting` = its sub-agent asked something. */
export const SUBTASK_STATUSES = ["pending", "running", "waiting", "done", "failed"] as const;
export type SubtaskStatus = (typeof SUBTASK_STATUSES)[number];
export const SubtaskStatusSchema = z.enum(SUBTASK_STATUSES);

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

/** Fixed default tag vocabulary. `evidence` is the default for card.needs_evidence. */
export const DEFAULT_TAGS = [
  { id: "tag_bug", name: "bug", evidence: false },
  { id: "tag_feature", name: "feature", evidence: true },
  { id: "tag_change", name: "change", evidence: true },
  { id: "tag_refactor", name: "refactor", evidence: false },
  { id: "tag_test", name: "test", evidence: false },
  { id: "tag_doc", name: "doc", evidence: false },
  { id: "tag_research", name: "research", evidence: false },
] as const;

export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const CARD_KEY_PATTERN = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/;
