import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PROVIDERS = ["claude", "codex", "kimi", "deepseek"] as const;
export type UsageProvider = (typeof PROVIDERS)[number];

export const PERIODS = ["today", "7d", "30d", "all"] as const;
export const PeriodSchema = z.enum(PERIODS);
export type Period = z.infer<typeof PeriodSchema>;

/** Host-scoped settings: log locations can be overridden (Kimi / DeepSeek paths are unverified). */
export const statsSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Extra or replacement log directories per provider; empty = built-in defaults. */
    logDirs: z
      .object({
        claude: z.array(z.string()).default([]),
        codex: z.array(z.string()).default([]),
        kimi: z.array(z.string()).default([]),
        deepseek: z.array(z.string()).default([]),
      })
      .default({ claude: [], codex: [], kimi: [], deepseek: [] }),
    /** Optional LiteLLM-format price file (the data ccusage uses); overrides the built-in table. */
    pricingFile: z.string().default(""),
    scanIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  }),
});

const Tokens = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
  events: z.number(),
});
export type TokenTotals = z.infer<typeof Tokens>;

const Group = Tokens.extend({ key: z.string(), label: z.string() });
export type StatsGroup = z.infer<typeof Group>;

const Speed = z.object({
  provider: z.string(),
  median: z.number().nullable(),
  p90: z.number().nullable(),
  samples: z.number(),
});

const TaskRow = z.object({
  cardId: z.string(),
  key: z.string(),
  title: z.string(),
  tokens: z.number(),
  cost: z.number(),
  durationMs: z.number(),
  waitingMs: z.number(),
  compactions: z.array(z.object({ before: z.number(), after: z.number() })),
});

export const OverviewSchema = z.object({
  generatedAt: z.string(),
  period: PeriodSchema,
  totals: Tokens,
  byProvider: z.array(Group),
  byModel: z.array(Group),
  byProject: z.array(Group),
  byDay: z.array(Group),
  speed: z.object({ overall: Speed, byProvider: z.array(Speed) }),
  tasks: z.array(TaskRow),
  compactions: z.object({ count: z.number(), avgBefore: z.number(), avgAfter: z.number() }),
  resources: z.object({
    runningSessions: z.number(),
    waitingSessions: z.number(),
    latest: z
      .object({
        ts: z.string(),
        cpu: z.number(),
        mem: z.number(),
        sessions: z.number(),
        devicesBusy: z.number(),
        devicesTotal: z.number(),
      })
      .nullable(),
    history: z.array(z.object({ ts: z.string(), cpu: z.number(), mem: z.number() })),
  }),
  index: z.object({ files: z.number(), lastScanAt: z.string().nullable() }),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const overviewRpc = defineRpc({
  name: "stats.overview",
  input: z.object({ period: PeriodSchema.default("30d") }),
  output: OverviewSchema,
});

const QuotaWindow = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().nullable(),
  resetsAt: z.string().nullable(),
  runsOutAt: z.string().nullable(),
  tone: z.string().nullable(),
});
export const QuotaSchema = z.object({
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
  providers: z.array(
    z.object({
      providerId: z.string(),
      displayName: z.string(),
      status: z.string(),
      planLabel: z.string().nullable(),
      windows: z.array(QuotaWindow),
    }),
  ),
});
export type Quota = z.infer<typeof QuotaSchema>;

export const quotaRpc = defineRpc({
  name: "stats.quota",
  input: z.object({}),
  output: QuotaSchema,
});

export const reindexRpc = defineRpc({
  name: "stats.reindex",
  input: z.object({ full: z.boolean().default(false) }),
  output: z.object({ files: z.number(), lines: z.number() }),
});
