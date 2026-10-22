// Settings and RPC contracts of vibe-master (shared by the server and the client UI).

import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Host-scoped defaults. A manual switch (RPC `master.switch`) overrides provider/model/thinking. */
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
] as const;

export const masterSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  /** v1 -> v2 (WP-105): drop the card-flow trigger settings. */
  migrate: (values) => {
    if (!values || typeof values !== "object") return values;
    const next: Record<string, unknown> = { ...(values as Record<string, unknown>) };
    for (const key of REMOVED_SETTING_KEYS) delete next[key];
    return next;
  },
  schema: z.object({
    enabled: z.boolean().default(true),
    /** Default master subscription. Empty model = best match from the provider catalog. */
    provider: z.string().default("claude"),
    model: z.string().default(""),
    thinking: z.string().default(""),
    /**
     * Permission mode of the master: "auto" = the provider's automatic mode (Claude auto, Codex
     * auto-review), else a concrete Paseo modeId of the provider.
     */
    permissionMode: z.string().default("auto"),
    /** cwd of the master agent. Empty = <VIBE_HOME>/master. */
    workspaceDir: z.string().default(""),
    /** Alert when the master's provider has at most this much quota left (percent). */
    quotaLowPct: z.number().min(1).max(90).default(20),
    quotaCheckSeconds: z.number().int().min(30).max(3600).default(300),
    /** On start, consolidate recently finished cards that have no memory update yet. */
    sweepOnStart: z.boolean().default(true),

    // ---- triggers (WP-93; WP-105 removed the draft review and worker-question wakes) ----
    /** A card reached done: the master consolidates project memory. */
    consolidateOnDone: z.boolean().default(true),
    /** At card done the master may also return an update of the project's requirements document. */
    maintainRequirements: z.boolean().default(true),

    // ---- prompts (WP-93, moved to the prompt registry by WP-98) ----
    // COMPAT(prompt-registry): added 2026-10-21, remove after 2027-04-01
    // These were edited here before the shared prompt registry existed. They are only read once,
    // on the first start after the upgrade, and copied into global overrides (server/prompts/migrate.ts);
    // after that the "Agent behaviour" page is the only place to edit them.
    rulesSupplement: z.string().default(""),
    templateCardDone: z.string().default(""),

    // ---- project context (WP-93) ----
    /** Max characters of the requirements document handed to the master in the project block. */
    requirementsExcerptChars: z.number().int().min(0).max(50_000).default(6000),

    // ---- advanced automation parameters (WP-98) ----
    /** How long one question to the master may take (memory consolidation). */
    askTimeoutMinutes: z.number().int().min(1).max(120).default(5),
    /** How long one planning-session turn may take. */
    planTurnTimeoutMinutes: z.number().int().min(1).max(120).default(10),
    /** How long a planning scout may take. */
    scoutTimeoutMinutes: z.number().int().min(1).max(120).default(5),
    /** Scout rounds a planning session may request per owner message. */
    maxResearchRounds: z.number().int().min(0).max(10).default(2),
    /** Turns one planning pass may run back to back. */
    maxPlanLoops: z.number().int().min(1).max(100).default(10),
    /** Extra asks after a reply failed validation (0 = take the first reply as it is). */
    jsonRepairRetries: z.number().int().min(0).max(5).default(1),
    /** The start-up sweep consolidates cards that finished within this many hours. */
    sweepDoneWindowHours: z.number().int().min(1).max(720).default(48),
    /** Quiet period between two alerts of the same kind and subject. */
    alertCooldownQuotaLowMinutes: z.number().int().min(1).max(1440).default(360),
    alertCooldownUrgentMinutes: z.number().int().min(1).max(1440).default(10),
    alertCooldownRoutineMinutes: z.number().int().min(1).max(1440).default(60),
    /** Other open cards listed in the project block of every wake message. */
    projectBlockCardLimit: z.number().int().min(0).max(200).default(40),
    /** Size cap of the hand-off summary for a new master, and how many days "recent" covers. */
    handoffMaxChars: z.number().int().min(500).max(30_000).default(3500),
    handoffRecentDays: z.number().int().min(1).max(60).default(7),
  }),
});
export type MasterSettings = z.output<typeof masterSettings.schema>;

const Target = z.object({
  provider: z.string(),
  model: z.string(),
  thinking: z.string().nullable(),
});
export type MasterTarget = z.infer<typeof Target>;

const ModelInfo = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  thinking: z.array(z.object({ id: z.string(), label: z.string() })),
});

export const ProviderInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  remainingPct: z.number().nullable(),
  level: z.enum(["ok", "tight", "exhausted", "unknown"]),
  models: z.array(ModelInfo),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

const PermissionInfo = z.object({
  /** The setting value: "auto" or a modeId. */
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
  targetSource: z.enum(["settings", "switched"]),
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
    running: z.object({ kind: z.string(), cardKey: z.string().nullable() }).nullable(),
    pending: z.array(
      z.object({
        kind: z.string(),
        cardKey: z.string().nullable(),
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
  providers: z.array(ProviderInfoSchema),
});
export type MasterStatus = z.infer<typeof MasterStatusSchema>;

export const statusRpc = defineRpc({
  name: "master.status",
  input: z.object({ includeProviders: z.boolean().default(false) }),
  output: MasterStatusSchema,
});

export const switchRpc = defineRpc({
  name: "master.switch",
  input: z.object({
    provider: z.string().min(1),
    /** Empty/omitted = pick from the catalog (Claude: Opus; others: the default model). */
    model: z.string().optional(),
    /** A thinking option id, or "max" for the provider's highest option. */
    thinking: z.string().optional(),
    reason: z.string().optional(),
  }),
  output: z.object({ target: Target, changed: z.boolean(), sessionId: z.string().nullable() }),
});

export const wakeRpc = defineRpc({
  name: "master.wake",
  input: z.object({
    /** Card key (PROD-12) or id. */
    card: z.string().min(1),
    reason: z.enum(["card_done"]).default("card_done"),
    /** Skip the "already consolidated" check. */
    force: z.boolean().default(true),
  }),
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
