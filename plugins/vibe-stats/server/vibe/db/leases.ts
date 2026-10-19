// GENERATED FROM plugins/vibe-shared — DO NOT EDIT (run: node scripts/vibe/sync-shared.mjs)
// Exclusive device leases on the scheduler-owned `device` / `device_lease` tables (WP-34).
// Shared so that vibe-scheduler (admission leases) and vibe-verify (collector leases) use one
// implementation; callers must have run migrateOwner(db, "scheduler") first.
//
// The `session_id` column carries an owner marker: "scheduler:<cardId>" for admission leases,
// "verify:<verificationId>" for evidence runs. At most one active lease per device is enforced by
// the partial unique index; expired leases are reaped before every acquire.

import type { DeviceKind } from "../contract/enums";
import { newId } from "../contract/ids";
import type { VibeDb } from "./sqlite";

export interface DeviceLeaseRequest {
  /** Device kind, or a platform name that maps to one (android -> emulator, ios -> simulator). */
  kind?: DeviceKind;
  platform?: string;
  cardId?: string | null;
  /** Owner marker, e.g. "scheduler:<cardId>". Falls back to "verify:<verificationId>". */
  sessionId?: string | null;
  verificationId?: string;
  /** Lease a specific device: its id, name, or adb serial. */
  preferredDeviceId?: string;
  /** 0 = no expiry. */
  ttlMs: number;
  signal?: AbortSignal;
}

export interface DeviceLeaseHandle {
  leaseId: string;
  deviceId: string;
  serial?: string;
  avd?: string;
  release(): Promise<void>;
}

export interface DeviceLeaseProvider {
  acquire(request: DeviceLeaseRequest): Promise<DeviceLeaseHandle>;
}

export interface DeviceRow {
  id: string;
  kind: DeviceKind;
  name: string;
  meta: Record<string, unknown>;
}

export interface DeviceLeaseOptions {
  now?: () => Date;
  /** Wait between attempts while all matching devices are busy. Default 1000. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PLATFORM_KIND: Record<string, DeviceKind> = {
  android: "emulator",
  ios: "simulator",
  embedded: "board",
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createDeviceLeases(db: VibeDb, options: DeviceLeaseOptions = {}) {
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;

  type Raw = { id: string; kind: string; name: string; meta_json: string };
  const toDevice = (r: Raw): DeviceRow => ({
    id: r.id,
    kind: r.kind as DeviceKind,
    name: r.name,
    meta: JSON.parse(r.meta_json || "{}") as Record<string, unknown>,
  });

  function registerDevice(input: {
    kind: DeviceKind;
    name: string;
    meta?: Record<string, unknown>;
  }): DeviceRow {
    const existing = db.prepare<Raw>("SELECT * FROM device WHERE name = ?").get(input.name);
    if (existing) {
      db.prepare("UPDATE device SET kind = ?, meta_json = ? WHERE id = ?").run(
        input.kind,
        input.meta ? JSON.stringify(input.meta) : existing.meta_json,
        existing.id,
      );
      return toDevice(db.prepare<Raw>("SELECT * FROM device WHERE id = ?").get(existing.id)!);
    }
    const id = newId(now().getTime());
    db.prepare(
      "INSERT INTO device (id, kind, name, meta_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, input.kind, input.name, JSON.stringify(input.meta ?? {}), now().toISOString());
    return toDevice(db.prepare<Raw>("SELECT * FROM device WHERE id = ?").get(id)!);
  }

  function removeDevice(id: string): void {
    db.prepare("DELETE FROM device WHERE id = ?").run(id);
  }

  function listDevices(kind?: DeviceKind): DeviceRow[] {
    const rows = kind
      ? db.prepare<Raw>("SELECT * FROM device WHERE kind = ? ORDER BY name").all(kind)
      : db.prepare<Raw>("SELECT * FROM device ORDER BY name").all();
    return rows.map(toDevice);
  }

  function reapExpired(): number {
    const at = now().toISOString();
    return db
      .prepare(
        "UPDATE device_lease SET released_at = ? WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(at, at).changes;
  }

  function release(leaseId: string): void {
    db.prepare("UPDATE device_lease SET released_at = ? WHERE id = ? AND released_at IS NULL").run(
      now().toISOString(),
      leaseId,
    );
  }

  interface LeaseRow {
    id: string;
    device_id: string;
    card_id: string | null;
    session_id: string | null;
    expires_at: string | null;
  }

  function activeLeases(): LeaseRow[] {
    reapExpired();
    return db.prepare<LeaseRow>("SELECT * FROM device_lease WHERE released_at IS NULL").all();
  }

  function matching(request: DeviceLeaseRequest): DeviceRow[] {
    const kind = request.kind ?? (request.platform ? PLATFORM_KIND[request.platform] : undefined);
    const want = request.preferredDeviceId;
    return listDevices(kind).filter(
      (d) => !want || d.id === want || d.name === want || d.meta.serial === want,
    );
  }

  /** Lease a free matching device now, or return null when all are busy. */
  function tryAcquire(request: DeviceLeaseRequest): DeviceLeaseHandle | null {
    const candidates = matching(request);
    if (candidates.length === 0) throw new Error("No matching device registered");
    return db.immediate(() => {
      const busy = new Set(activeLeases().map((l) => l.device_id));
      const device = candidates.find((d) => !busy.has(d.id));
      if (!device) return null;
      const id = newId(now().getTime());
      const at = now();
      db.prepare(
        `INSERT INTO device_lease (id, device_id, card_id, session_id, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        device.id,
        request.cardId ?? null,
        request.sessionId ?? (request.verificationId ? `verify:${request.verificationId}` : null),
        at.toISOString(),
        request.ttlMs > 0 ? new Date(at.getTime() + request.ttlMs).toISOString() : null,
      );
      const meta = device.meta;
      return {
        leaseId: id,
        deviceId: device.id,
        serial: typeof meta.serial === "string" ? meta.serial : undefined,
        avd: typeof meta.avd === "string" ? meta.avd : undefined,
        release: async () => release(id),
      };
    });
  }

  /** Waits for a free device; rejects when aborted or when no matching device is registered. */
  async function acquire(request: DeviceLeaseRequest): Promise<DeviceLeaseHandle> {
    for (;;) {
      if (request.signal?.aborted) throw new Error("Device lease aborted");
      const handle = tryAcquire(request);
      if (handle) return handle;
      await sleep(pollMs);
    }
  }

  /** Pool state for resource_sample.device_pool_json: {busy, total, devices}. */
  function poolStatus() {
    const leases = new Map(activeLeases().map((l) => [l.device_id, l]));
    const devices: Record<string, { kind: DeviceKind; leased: boolean; cardId: string | null }> =
      {};
    for (const d of listDevices()) {
      const l = leases.get(d.id);
      devices[d.name] = { kind: d.kind, leased: !!l, cardId: l?.card_id ?? null };
    }
    const all = Object.values(devices);
    return { busy: all.filter((d) => d.leased).length, total: all.length, devices };
  }

  return {
    registerDevice,
    removeDevice,
    listDevices,
    tryAcquire,
    acquire,
    release,
    reapExpired,
    activeLeases,
    poolStatus,
    provider: { acquire } satisfies DeviceLeaseProvider,
  };
}

export type DeviceLeases = ReturnType<typeof createDeviceLeases>;
