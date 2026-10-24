import type { DeviceKind } from "./vibe/contract";

export interface SchedulerConfig {
  globalLimit: number;
  providerLimits: Record<string, number>;
  memoryThreshold: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  globalLimit: 4,
  providerLimits: {},
  memoryThreshold: 0.85,
};

/** Device kind a runtime environment needs, or null when it needs no exclusive device. */
export function deviceKindFor(runtimeEnv: string | null | undefined): DeviceKind | null {
  const env = (runtimeEnv ?? "").toLowerCase();
  if (/android|emulator/.test(env)) return "emulator";
  if (/\bios\b|simulator/.test(env)) return "simulator";
  if (/board|embedded|firmware/.test(env)) return "board";
  return null;
}
