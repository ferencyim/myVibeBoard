import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const PriorityEnum = z.enum(["urgent", "high", "medium", "low", "none"]);

export const AgentProfileSchema = z.object({
  id: z.string(),
  provider: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  strengths: z.array(z.string()).default([]),
  platforms: z.array(z.string()).optional(),
  presetId: z.string().nullable().optional(),
});

export const schedulerSettings = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Maximum worker sessions running at once (all providers). */
    globalLimit: z.number().int().min(1).max(64).default(4),
    /** Per provider caps, e.g. {"claude": 2}. The smallest of global / provider / device pool wins. */
    providerLimits: z.record(z.string(), z.number().int().min(1)).default({}),
    /** Pause admissions and emulator starts above this fraction of physical memory. */
    memoryThreshold: z.number().min(0.5).max(0.99).default(0.85),
    /** Remaining quota (%) at or below which a provider counts as tight / exhausted. */
    quotaTightPct: z.number().min(0).max(100).default(25),
    quotaExhaustedPct: z.number().min(0).max(100).default(5),
    /** While a provider is tight only cards at this priority or higher may use it. */
    tightMinPriority: PriorityEnum.default("high"),
    devPortBase: z.number().int().min(1024).max(65000).default(3100),
    devPortSpan: z.number().int().min(10).max(5000).default(900),
    deviceLeaseMinutes: z.number().int().min(1).default(240),
    tickSeconds: z.number().int().min(1).max(600).default(5),
    sampleSeconds: z.number().int().min(5).max(3600).default(15),
    sampleRetentionDays: z.number().int().min(1).max(365).default(7),
    /** Capability table entries; same id replaces the built-in entry. */
    agentProfiles: z.array(AgentProfileSchema).default([]),
  }),
});

export const statusRpc = defineRpc({
  name: "scheduler.status",
  input: z.object({}),
  output: z.record(z.string(), z.unknown()),
});

export const selectAgentRpc = defineRpc({
  name: "scheduler.selectAgent",
  input: z.object({
    tags: z.array(z.string()).default([]),
    size: z.enum(["S", "M", "L", "XL"]).optional(),
    platform: z.string().optional(),
    priority: PriorityEnum.default("medium"),
    device: z.string().nullable().optional(),
    preselected: z.string().nullable().optional(),
    /** Project directories whose .vibe/workers/<agent>/MEMORY.md feed the track record. */
    repoPath: z.string().optional(),
  }),
  output: z.record(z.string(), z.unknown()),
});

const DeviceKind = z.enum(["emulator", "simulator", "board", "debugger", "camera", "other"]);

export const devicesRpc = defineRpc({
  name: "scheduler.devices",
  input: z.object({}),
  output: z.object({ devices: z.array(z.record(z.string(), z.unknown())) }),
});

export const registerDeviceRpc = defineRpc({
  name: "scheduler.registerDevice",
  input: z.object({
    kind: DeviceKind,
    name: z.string().min(1),
    serial: z.string().optional(),
    avd: z.string().optional(),
  }),
  output: z.record(z.string(), z.unknown()),
});

export const removeDeviceRpc = defineRpc({
  name: "scheduler.removeDevice",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
