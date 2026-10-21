// Settings and RPC contracts of vibe-master (shared by the server and the client UI).

import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Host-scoped defaults. A manual switch (RPC `master.switch`) overrides provider/model/thinking. */
export const masterSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    /** Default master subscription. Empty model = best match from the provider catalog. */
    provider: z.string().default("claude"),
    model: z.string().default(""),
    thinking: z.string().default(""),
    /**
     * Permission mode of the master and the planning agents: "auto" = the provider's automatic
     * mode (Claude auto, Codex auto-review), else a concrete Paseo modeId of the provider.
     */
    permissionMode: z.string().default("auto"),
    /** Quiet period after a draft was created or edited before the master looks at it. */
    debounceSeconds: z.number().int().min(1).max(600).default(30),
    /** cwd of the master agent. Empty = <VIBE_HOME>/master. */
    workspaceDir: z.string().default(""),
    /** Alert when the master's provider has at most this much quota left (percent). */
    quotaLowPct: z.number().min(1).max(90).default(20),
    quotaCheckSeconds: z.number().int().min(30).max(3600).default(300),
    /** On start, also assess drafts that have no up-to-date assessment (newest N, see sweepDraftLimit). */
    sweepOnStart: z.boolean().default(true),

    // ---- triggers (WP-93) ----
    /** Review a draft automatically after it was created / its owner fields were edited / it was moved back to draft. */
    autoAssessOnCreate: z.boolean().default(true),
    autoAssessOnEdit: z.boolean().default(true),
    autoAssessOnMoveToDraft: z.boolean().default(true),
    /** How many of the newest unreviewed drafts the start-up sweep queues. */
    sweepDraftLimit: z.number().int().min(1).max(50).default(10),
    /** A worker session asked a question (session.waiting): wake the master for advice. */
    wakeOnSessionWaiting: z.boolean().default(true),
    /** A card reached done: the master consolidates project memory. */
    consolidateOnDone: z.boolean().default(true),
    /** At card done the master may also return an update of the project's requirements document. */
    maintainRequirements: z.boolean().default(true),

    // ---- prompts (WP-93) ----
    /** Appended after the static SKILL rules (system prompt). */
    rulesSupplement: z.string().default(""),
    /** Wake templates with {{placeholders}}; empty = the built-in default. The reply format section is always appended. */
    templateAssessDraft: z.string().default(""),
    templateCardDone: z.string().default(""),
    templateSessionHelp: z.string().default(""),

    // ---- project context (WP-93) ----
    /** Max characters of the requirements document handed to the master in the project block. */
    requirementsExcerptChars: z.number().int().min(0).max(50_000).default(6000),
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
    reason: z.enum(["assess_draft", "card_done"]).default("assess_draft"),
    /** Skip the debounce and the "already assessed" check. */
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

const PromptInfo = z.object({
  /** Settings key holding the override. */
  settingKey: z.enum(["templateAssessDraft", "templateCardDone", "templateSessionHelp"]),
  label: z.string(),
  description: z.string(),
  placeholders: z.array(z.object({ name: z.string(), description: z.string() })),
  defaultTemplate: z.string(),
  /** Appended automatically after the template; not editable. */
  formatSection: z.string(),
});
export type PromptInfo = z.infer<typeof PromptInfo>;

export const promptsRpc = defineRpc({
  name: "master.prompts",
  input: z.object({}),
  output: z.object({ prompts: z.array(PromptInfo) }),
});
