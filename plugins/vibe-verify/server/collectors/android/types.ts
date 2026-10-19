// Public types of the Android collector (WP-23): lease seam, process spawner seam, app/flow config.

import type { z } from "zod";
import type { CollectorContext } from "../../vibe/contract";
import type {
  AdbStepSchema,
  AndroidAppConfigSchema,
  AndroidFlowSchema,
  MetroConfigSchema,
} from "./config";

// --- device lease (device / device_lease tables are owned by vibe-scheduler, WP-34) ------------

export interface DeviceLeaseRequest {
  platform: "android";
  cardId: string;
  verificationId: string;
  /** Lease a specific device (adb serial / device id) when set; otherwise any free emulator. */
  preferredDeviceId?: string;
  ttlMs: number;
  signal?: AbortSignal;
}

export interface DeviceLeaseHandle {
  leaseId: string;
  /** Device id as registered in the `device` table; also the adb serial unless `serial` is set. */
  deviceId: string;
  serial?: string;
  /** AVD name, used to boot the emulator when it is not running yet. */
  avd?: string;
  release(): Promise<void>;
}

/**
 * Exclusive-device seam. The scheduler (WP-34) implements it on top of device_lease; until then
 * `createInMemoryLeaseProvider` is used. `acquire` waits for a free device and rejects when the
 * request is aborted or no device is registered.
 */
export interface DeviceLeaseProvider {
  acquire(request: DeviceLeaseRequest): Promise<DeviceLeaseHandle>;
}

// --- long-running processes (emulator, Metro) -----------------------------------------------

export interface SpawnedProcess {
  pid?: number;
  kill(): void;
}

export interface ProcessSpawner {
  spawn(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; env?: Record<string, string> },
  ): SpawnedProcess;
}

// --- app + flow configuration -----------------------------------------------------------------

export type AdbStep = z.infer<typeof AdbStepSchema>;
export type AndroidFlow = z.infer<typeof AndroidFlowSchema>;
export type MetroConfig = z.infer<typeof MetroConfigSchema>;
export type AndroidAppConfig = z.infer<typeof AndroidAppConfigSchema>;

export interface AndroidCollectorOptions {
  /** App to verify. Default: `android.app` of `<worktree>/.vibe/verify.json`. */
  app?: AndroidAppConfig | ((ctx: CollectorContext) => AndroidAppConfig);
  /** Flow for a check (or card-wide). Default: `android.flow` of verify.json; none = launch + screenshot. */
  flow?: AndroidFlow | ((ctx: CollectorContext) => AndroidFlow | undefined);
  /** Used when `ctx.deviceId` is absent (the caller then does not hold a lease). */
  leases?: DeviceLeaseProvider;
  /** Needed to boot an AVD / start Metro. Without it only already-running devices work. */
  spawner?: ProcessSpawner;
  adbPath?: string;
  emulatorPath?: string;
  ffmpegPath?: string;
  maestroPath?: string;
  /** Record the screen for the flow and convert to GIF (default true). */
  record?: boolean;
  leaseTtlMs?: number;
  bootTimeoutMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  fileExists?: (path: string) => boolean;
  /** GET url, true when it answered 2xx within timeoutMs (Metro status/bundle probe). */
  httpProbe?: (url: string, timeoutMs: number) => Promise<boolean>;
}
