import { describe, expect, it } from "vitest";
import {
  formatLimits,
  parseDevices,
  parseLimits,
  parseStatus,
  pauseReason,
} from "../client/format";

describe("scheduler screen helpers", () => {
  it("normalises the loose status record, including missing parts", () => {
    expect(parseStatus(undefined)).toMatchObject({
      paused: false,
      pending: [],
      deferred: [],
      quota: [],
      pool: [],
    });
    const view = parseStatus({
      paused: true,
      running: { total: 2, byProvider: { claude: 2 } },
      pending: [
        { id: "lease-1", workspaceId: "DEMO-1", role: "worker", provider: "claude", port: 3100 },
      ],
      deferred: { "DEMO-2": "global limit 4 reached" },
      resources: { cpu: 0.2, mem: 0.91 },
      quota: { codex: { level: "tight", remainingPct: 20, resetsAt: null } },
      pool: { devices: { pixel: { kind: "emulator", leased: true } } },
    });
    expect(view.pending[0]).toMatchObject({ id: "lease-1", workspaceId: "DEMO-1", role: "worker" });
    expect(view.running).toEqual({ total: 2, byProvider: { claude: 2 } });
    expect(view.deferred).toEqual([{ workspaceId: "DEMO-2", reason: "global limit 4 reached" }]);
    expect(view.quota[0]).toMatchObject({ provider: "codex", level: "tight", remainingPct: 20 });
    expect(view.pool[0]).toMatchObject({ name: "pixel", leased: true });
    expect(pauseReason(view, 0.85)).toContain("内存 91%，阈值 85%");
    expect(pauseReason({ ...view, paused: false }, 0.85)).toBeNull();
  });

  it("reads device rows and shows serial / avd as detail", () => {
    expect(
      parseDevices({
        devices: [
          {
            id: "d1",
            kind: "emulator",
            name: "pixel",
            meta: { serial: "emulator-5554", avd: "Pixel_8" },
          },
        ],
      }),
    ).toEqual([{ id: "d1", kind: "emulator", name: "pixel", detail: "emulator-5554 · Pixel_8" }]);
    expect(parseDevices(null)).toEqual([]);
  });

  it("round-trips per provider limits and drops invalid parts", () => {
    expect(parseLimits("claude=2, codex = 1, bad, x=0, y=1.5")).toEqual({ claude: 2, codex: 1 });
    expect(formatLimits({ claude: 2, codex: 1 })).toBe("claude=2, codex=1");
  });
});
