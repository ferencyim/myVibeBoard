// Settings and RPC contracts of vibe-master (shared by the server and the client UI).

import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PromptDefSchema } from "./vibe/contract";
import { BotSchema, BotCreateSchema, BotMemorySchema } from "./vibe/contract/bots";

const promptScope = z.string().min(1).nullable().optional();
export const promptsListRpc = defineRpc({
  name: "vibe.prompts.list",
  input: z.object({ projectId: promptScope }),
  output: z.object({
    prompts: z.array(
      PromptDefSchema.extend({
        globalOverride: z.string().nullable(),
        projectOverride: z.string().nullable(),
        source: z.enum(["default", "global", "project"]),
        effectiveText: z.string(),
        overriddenProjects: z.array(z.string()),
      }),
    ),
    projects: z.array(z.object({ id: z.string(), name: z.string(), prefix: z.string() })),
  }),
});
export const promptsSetRpc = defineRpc({
  name: "vibe.prompts.set",
  input: z.object({ key: z.string().min(1), text: z.string(), projectId: promptScope }),
  output: z.object({ ok: z.literal(true) }),
});
export const promptsClearRpc = defineRpc({
  name: "vibe.prompts.clear",
  input: z.object({ key: z.string().min(1), projectId: promptScope }),
  output: z.object({ ok: z.literal(true) }),
});

/** Settings keys of the card-flow triggers that WP-105 removed (the master left the card flow). */
export const REMOVED_SETTING_KEYS = [
  "debounceSeconds",
  "autoAssessOnCreate",
  "autoAssessOnEdit",
  "autoAssessOnMoveToDraft",
  "sweepDraftLimit",
  "wakeOnSessionWaiting",
  "proposalWindowSeconds",
  "templateAssessDraft",
  "templateSessionHelp",
  "templateCardDone",
  "planTurnTimeoutMinutes",
  "scoutTimeoutMinutes",
  "maxResearchRounds",
  "maxPlanLoops",
  "sweepDoneWindowHours",
  "projectBlockCardLimit",
  "sweepOnStart",
  "consolidateOnDone",
  "maintainRequirements",
  "requirementsExcerptChars",
  "dispatch",
  "dispatchTimeoutSeconds",
] as const;

export const masterSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 5,
  /** WP-105 / WP-114: remove retired card automation settings. */
  migrate: (values) => {
    if (!values || typeof values !== "object") return values;
    const next: Record<string, unknown> = { ...(values as Record<string, unknown>) };
    next.legacyProjectMaintenance ??= Object.fromEntries(
      ["consolidateOnDone", "maintainRequirements", "sweepOnStart"]
        .filter((key) => typeof next[key] === "boolean")
        .map((key) => [key, next[key]]),
    );
    for (const key of REMOVED_SETTING_KEYS) delete next[key];
    return next;
  },
  schema: z.object({
    // COMPAT(WP-134): added 2026-10-28; remove after 2027-04-01 once old master v3 settings have migrated to board.
    legacyProjectMaintenance: z.record(z.string(), z.boolean()).optional(),
    enabled: z.boolean().default(true),
    /**
     * The agent preset the master runs on (WP-109; provider, model and thinking come from it).
     * Empty = not chosen yet, unless the legacy fields below still match a preset.
     */
    presetId: z.string().default(""),
    // COMPAT(master-preset): added 2026-10-22, remove after 2027-04-01
    // Before WP-109 the master had its own provider/model/thinking. They are only read to find the
    // matching preset for an owner who never picked one; choosing a preset in the settings clears them.
    provider: z.string().default(""),
    model: z.string().default(""),
    thinking: z.string().default(""),
    /**
     * Permission mode of the master: "preset" follows the current candidate; "auto" uses the provider's automatic mode (Claude auto, Codex
     * auto-review), else a concrete Paseo modeId of the provider.
     */
    permissionMode: z.string().default("preset"),
    /** cwd of the master agent. Empty = <VIBE_HOME>/master. */
    workspaceDir: z.string().default(""),
    /** Alert when the master's provider has at most this much quota left (percent). */
    quotaLowPct: z.number().min(1).max(90).default(20),
    quotaCheckSeconds: z.number().int().min(30).max(3600).default(300),
    // ---- prompts (WP-93, moved to the prompt registry by WP-98) ----
    // COMPAT(prompt-registry): added 2026-10-21, remove after 2027-04-01
    // These were edited here before the shared prompt registry existed. They are only read once,
    // on the first start after the upgrade, and copied into global overrides (server/prompts/migrate.ts);
    // after that the "Agent behaviour" page is the only place to edit them.
    rulesSupplement: z.string().default(""),

    // ---- advanced automation parameters (WP-98) ----
    /** How long one structured question to the master may take. */
    askTimeoutMinutes: z.number().int().min(1).max(120).default(5),
    /** Extra asks after a reply failed validation (0 = take the first reply as it is). */
    jsonRepairRetries: z.number().int().min(0).max(5).default(1),
    /** Quiet period between two alerts of the same kind and subject. */
    alertCooldownQuotaLowMinutes: z.number().int().min(1).max(1440).default(360),
    alertCooldownUrgentMinutes: z.number().int().min(1).max(1440).default(10),
    alertCooldownRoutineMinutes: z.number().int().min(1).max(1440).default(60),
    /** Size cap of the hand-off summary for a new master, and how many days "recent" covers. */
    handoffMaxChars: z.number().int().min(500).max(30_000).default(3500),
    handoffRecentDays: z.number().int().min(1).max(60).default(7),
  }),
});
export type MasterSettings = z.output<typeof masterSettings.schema>;

/** A preset the master can run on, with the quota of its provider (the settings page lists them). */
export const PresetChoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  thinking: z.string(),
  models: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
        thinking: z.string(),
        permissionMode: z.string().optional(),
      }),
    )
    .optional(),
  roleHints: z.array(z.string()),
  remainingPct: z.number().nullable(),
  level: z.enum(["ok", "tight", "exhausted", "unknown"]),
});
export type PresetChoice = z.infer<typeof PresetChoiceSchema>;

const Target = z.object({
  provider: z.string(),
  model: z.string(),
  thinking: z.string().nullable(),
});
export type MasterTarget = z.infer<typeof Target>;

const PermissionInfo = z.object({
  /** The setting value: "preset", "auto" or a modeId. */
  setting: z.string(),
  source: z.enum(["settings", "switched"]),
  /** Concrete mode in effect for the provider; null = the provider's own default. */
  modeId: z.string().nullable(),
  label: z.string(),
  auto: z.boolean(),
  options: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type PermissionInfo = z.infer<typeof PermissionInfo>;

export const MasterStatusSchema = z.object({
  enabled: z.boolean(),
  /** false until the first hook or RPC handed the plugin a daemon handle. */
  paseoReady: z.boolean(),
  target: Target.nullable(),
  /** The preset the master runs on; null = none chosen (the settings page asks for one). */
  preset: z.object({ id: z.string(), name: z.string(), migrated: z.boolean() }).nullable(),
  permission: PermissionInfo.nullable(),
  session: z
    .object({
      sessionId: z.string(),
      agentId: z.string(),
      provider: z.string(),
      state: z.string(),
    })
    .nullable(),
  queue: z.object({
    running: z.object({ kind: z.string(), workspaceId: z.string().nullable() }).nullable(),
    pending: z.array(
      z.object({
        kind: z.string(),
        workspaceId: z.string().nullable(),
        /** Seconds until a debounced job becomes due; 0 = due/queued. */
        dueInSeconds: z.number(),
      }),
    ),
    blocked: z.number(),
  }),
  /** vibe-scheduler paused admission (memory pressure). */
  schedulerPaused: z.boolean(),
  lastAlert: z.object({ kind: z.string(), message: z.string(), at: z.string() }).nullable(),
  switchHistory: z.array(
    z.object({ from: z.string(), to: z.string(), at: z.string(), reason: z.string().optional() }),
  ),
  presets: z.array(PresetChoiceSchema),
});
export type MasterStatus = z.infer<typeof MasterStatusSchema>;

export const statusRpc = defineRpc({
  name: "master.status",
  input: z.object({}),
  output: MasterStatusSchema,
});

export const taskWakeRpc = defineRpc({
  name: "master.task.wake",
  input: z.object({ workspaceId: z.string().min(1), force: z.boolean().default(false) }),
  output: z.object({ queued: z.boolean(), message: z.string() }),
});

export const permissionRpc = defineRpc({
  name: "master.permission",
  input: z.object({
    /** "auto", a modeId of the master's provider, or "settings" to follow the settings default. */
    mode: z.string().min(1),
  }),
  output: z.object({ permission: PermissionInfo.nullable(), changed: z.boolean() }),
});

const SessionRow = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  provider: z.string(),
  /** Model the session started with; empty for sessions recorded before this was tracked. */
  model: z.string(),
  thinking: z.string().nullable(),
  state: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  current: z.boolean(),
  /** Why the session was replaced (switched / mode_changed / replaced), if known. */
  retiredReason: z.string().nullable(),
});
export type MasterSessionRow = z.infer<typeof SessionRow>;

export const sessionsRpc = defineRpc({
  name: "master.sessions",
  input: z.object({ limit: z.number().int().min(1).max(100).default(30) }),
  output: z.object({ sessions: z.array(SessionRow) }),
});

const BotViewSchema = BotSchema.extend({ memories: z.array(BotMemorySchema), isDefault: z.boolean() });
export const botsListRpc = defineRpc({
  name: "bots.list",
  input: z.object({ kind: z.enum(["independent", "project"]).optional(), projectId: z.string().optional(), includeArchived: z.boolean().optional() }),
  output: z.object({ bots: z.array(BotViewSchema) }),
});
export const botsCreateRpc = defineRpc({ name: "bots.create", input: BotCreateSchema, output: z.object({ bot: BotViewSchema }) });
const BotConversationStateSchema = z.object({
  status: z.enum(["idle", "creating", "ready", "failed"]),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  error: z.string().nullable(),
});
export const botsOpenRpc = defineRpc({ name: "bots.open", input: z.object({ id: z.string() }), output: BotConversationStateSchema });
export const botsStateRpc = defineRpc({ name: "bots.state", input: z.object({ id: z.string() }), output: BotConversationStateSchema });
export const botsArchiveRpc = defineRpc({ name: "bots.archive", input: z.object({ id: z.string() }), output: z.object({ ok: z.literal(true) }) });

export const masterBotMigrationRpc = defineRpc({
  name: "vibe.master.bot_migration",
  input: z.object({}).strict(),
  output: z.object({
    presetId: z.string().nullable(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    thinking: z.string(),
    candidateIndex: z.number().int().min(0),
    models: z.array(z.object({ provider: z.string(), model: z.string(), thinking: z.string(), permissionMode: z.string() })),
    backupModels: z.array(z.object({ provider: z.string(), model: z.string(), thinking: z.string() })),
    instructions: z.string(),
    notifications: z.object({ enabled: z.boolean(), completed: z.boolean(), failed: z.boolean() }),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
  }),
});
