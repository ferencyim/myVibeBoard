// Real-emulator run. Off by default; enable with VIBE_E2E_ANDROID=1.
//   VIBE_E2E_ANDROID_SERIAL  adb serial of an emulator to use (default: first online emulator)
//   VIBE_E2E_ANDROID_APK / VIBE_E2E_ANDROID_PACKAGE  install and launch this (bundled) APK instead
//     of the preinstalled Settings app
// Only emulators are used; nothing is started or stopped by this test.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAndroidCollector,
  createInMemoryLeaseProvider,
} from "../../server/collectors/android";
import { createNodeRunner } from "../../server/collectors/common";
import { parseAdbDevices } from "../../server/collectors/android/adb";
import type { CollectorContext } from "../../server/vibe/contract";

const enabled = process.env.VIBE_E2E_ANDROID === "1";

describe.skipIf(!enabled)("android collector on a real emulator", () => {
  it("captures screenshots, recording and a logcat crash check", { timeout: 240_000 }, async () => {
    const online = parseAdbDevices(execFileSync("adb", ["devices"], { encoding: "utf8" }))
      .filter((d) => d.state === "device" && d.serial.startsWith("emulator-"))
      .map((d) => d.serial);
    const serial = process.env.VIBE_E2E_ANDROID_SERIAL ?? online[0];
    expect(serial, "no online emulator").toBeTruthy();
    expect(serial?.startsWith("emulator-")).toBe(true);

    const apk = process.env.VIBE_E2E_ANDROID_APK;
    const packageName = process.env.VIBE_E2E_ANDROID_PACKAGE ?? "com.android.settings";
    const leases = createInMemoryLeaseProvider([{ deviceId: "e2e-emulator", serial }]);
    const collector = createAndroidCollector({
      app: { packageName, mode: "bundled", apkPath: apk },
      flow: {
        steps: [
          { type: "wait", ms: 1000 },
          { type: "swipe", x1: 540, y1: 1600, x2: 540, y2: 600, durationMs: 400 },
          { type: "screenshot", label: "scrolled" },
        ],
      },
      leases,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "vibe-android-e2e-"));
    const ctx: CollectorContext = {
      cardId: null,
      workspaceId: "ws-android",
      confirmedAt: "2026-10-23T00:00:00.000Z",
      verificationId: "e2e-ver",
      projectType: "android",
      projectPath: dir,
      worktreePath: dir,
      commitHash: "e2e0000",
      outputDir: path.join(dir, "evidence"),
      check: { id: "settings-opens", text: "Settings app opens and scrolls", method: "adb" },
      runner: createNodeRunner(),
      now: () => new Date(),
      log: (m) => console.log(`[android-e2e] ${m}`),
    };

    expect((await collector.detect(ctx)).available).toBe(true);
    try {
      const result = await collector.collect(ctx);
      console.log(
        `[android-e2e] ${result.artifacts.length} artifacts in ${ctx.outputDir}\n` +
          result.artifacts.map((a) => `  ${a.kind} ${a.path}`).join("\n") +
          `\nnotes: ${result.notes.join(" | ")}\ndegraded=${result.degraded} judgement=${result.judgement}`,
      );
      for (const a of result.artifacts) expect(existsSync(a.path)).toBe(true);
      const kinds = result.artifacts.map((a) => a.kind);
      expect(kinds.filter((k) => k === "screenshot").length).toBeGreaterThanOrEqual(3);
      expect(kinds).toContain("log");
      expect(kinds).toContain("report");
      expect(result.judgement).not.toBe("fail");
    } finally {
      await collector.dispose?.(ctx);
    }
    expect(leases.held()).toEqual([]);
  });
});
