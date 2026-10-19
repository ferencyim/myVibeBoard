// In-memory DeviceLeaseProvider: stand-in until the scheduler (WP-34) backs leases with the
// device_lease table; also the fake used in unit tests.

import type { DeviceLeaseHandle, DeviceLeaseProvider, DeviceLeaseRequest } from "./types";

export interface LeasableDevice {
  deviceId: string;
  serial?: string;
  avd?: string;
}

export interface InMemoryLeaseProvider extends DeviceLeaseProvider {
  /** Device ids currently leased. */
  held(): string[];
}

export function createInMemoryLeaseProvider(devices: LeasableDevice[]): InMemoryLeaseProvider {
  const held = new Set<string>();
  const waiters: Array<() => void> = [];
  let counter = 0;

  const matches = (d: LeasableDevice, request: DeviceLeaseRequest) =>
    !request.preferredDeviceId ||
    d.deviceId === request.preferredDeviceId ||
    d.serial === request.preferredDeviceId;

  return {
    held: () => [...held],
    async acquire(request): Promise<DeviceLeaseHandle> {
      if (!devices.some((d) => matches(d, request))) {
        throw new Error("No matching Android device registered");
      }
      for (;;) {
        if (request.signal?.aborted) throw new Error("Device lease aborted");
        const device = devices.find((d) => !held.has(d.deviceId) && matches(d, request));
        if (device) {
          held.add(device.deviceId);
          let released = false;
          return {
            leaseId: `lease-${++counter}`,
            deviceId: device.deviceId,
            serial: device.serial,
            avd: device.avd,
            async release() {
              if (released) return;
              released = true;
              held.delete(device.deviceId);
              waiters.splice(0).forEach((wake) => wake());
            },
          };
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
}
