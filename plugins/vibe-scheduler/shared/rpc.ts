import { REMOTE_TARGET_PATTERN } from "./vibe/contract";
import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
    devPortBase: z.number().int().min(1024).max(65000).default(3100),
    devPortSpan: z.number().int().min(10).max(5000).default(900),
    tickSeconds: z.number().int().min(1).max(600).default(5),
    sampleSeconds: z.number().int().min(5).max(3600).default(15),
    remoteSampleSeconds: z.number().int().min(15).max(3600).default(60),
    sampleRetentionDays: z.number().int().min(1).max(365).default(7),
  }),
});

export const statusRpc = defineRpc({
  name: "scheduler.status",
  input: z.object({}),
  output: z.record(z.string(), z.unknown()),
});

const DeviceKind = z.enum(["emulator", "simulator", "board", "debugger", "camera", "other"]);

export const devicesRpc = defineRpc({
  name: "scheduler.devices",
  input: z.object({}),
  output: z.object({ devices: z.array(z.record(z.string(), z.unknown())) }),
});

export const registerDeviceRpc = defineRpc({
  name: "scheduler.register_device",
  input: z.object({
    kind: DeviceKind,
    name: z.string().min(1),
    serial: z.string().optional(),
    avd: z.string().optional(),
  }),
  output: z.record(z.string(), z.unknown()),
});

export const removeDeviceRpc = defineRpc({
  name: "scheduler.remove_device",
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

// Native task orchestration uses the same resource admission service as the event bus.
export const taskResourceRpc = defineRpc({
  name: "scheduler.task_resource",
  input: z.object({
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    action: z.enum(["acquire", "bind", "yield", "release", "freeze", "reconcile"]),
    role: z
      .enum([
        "scout",
        "planner",
        "plan_reviewer",
        "worker",
        "subagent",
        "reviewer",
        "verifier",
        "master",
      ])
      .optional(),
    subtaskId: z.string().optional(),
    agentId: z.string().optional(),
    reservationId: z.string().optional(),
    candidateIndex: z.number().int().min(0).optional(),
    presetId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    files: z.array(z.string()).optional(),
    hostLease: z.boolean().optional(),
  }),
  output: z.object({
    requestId: z.string(),
    workspaceId: z.string(),
    ok: z.boolean(),
    reason: z.string(),
    retryable: z.boolean().optional(),
    reservationId: z.string().optional(),
    presetId: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    port: z.number().optional(),
    deviceIds: z.array(z.string()).optional(),
  }),
});
export const taskTickRpc = defineRpc({
  name: "scheduler.task_tick",
  input: z.object({}),
  output: z.record(z.string(), z.unknown()),
});

const remoteHost = z.object({
  name: z.string().trim().min(1).max(80),
  target: z.string().regex(REMOTE_TARGET_PATTERN),
});
export const remoteHostsRpc = defineRpc({
  name: "scheduler.remote_hosts",
  input: z.object({ hosts: z.array(remoteHost).max(32).optional() }),
  output: z.object({ hosts: z.array(remoteHost) }),
});
