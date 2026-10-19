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
    /** On start, also assess drafts that have no up-to-date assessment (newest 10). */
    sweepOnStart: z.boolean().default(true),
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
