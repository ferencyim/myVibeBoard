// Real-Mac run over ssh. Off by default; enable with VIBE_E2E_IOS=1.
//   VIBE_MAC_HOST            ssh alias of the Mac (from the user's ~/.ssh/config; never committed)
//   VIBE_MAC_DEVELOPER_DIR   optional DEVELOPER_DIR on the Mac (Xcode on an external disk, ...)
//   VIBE_E2E_IOS_DEVICE      simulator name or UDID (default "iPhone 16")
//   VIBE_E2E_IOS_BUNDLE      bundle id to launch (default com.apple.Preferences, preinstalled)
//   VIBE_E2E_IOS_APP         local simulator .app directory to sync + install (optional)
//   VIBE_E2E_IOS_BUILD_CWD   directory on the Mac with an Xcode project to build remotely (optional);
//   VIBE_E2E_IOS_SCHEME      its scheme (default EvidenceApp); the product is expected at
//                            build/Build/Products/Debug-iphonesimulator/<scheme>.app
// A throw-away SwiftUI test app and the commands to build it are described in the plugin README.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeRunner } from "../../server/collectors/common";
import { createIosCollector, type IosConfig } from "../../server/collectors/ios";
import { makeCtx } from "../helpers";

const enabled = process.env.VIBE_E2E_IOS === "1";
const device = process.env.VIBE_E2E_IOS_DEVICE ?? "iPhone 16";
const bundleId = process.env.VIBE_E2E_IOS_BUNDLE ?? "com.apple.Preferences";
const scheme = process.env.VIBE_E2E_IOS_SCHEME ?? "EvidenceApp";

async function run(config: IosConfig, expectVideo = true) {
  const collector = createIosCollector({ config });
  const runner = createNodeRunner();
  const ctx = makeCtx({
    projectType: "ios",
    runner,
    outputDir: mkdtempSync(path.join(tmpdir(), "vibe-ios-e2e-")),
    verificationId: `e2e-${Date.now()}`,
  });
  const availability = await collector.detect(ctx);
  expect(availability.available, availability.reason).toBe(true);
  try {
    const result = await collector.collect(ctx);
    console.log(`[ios e2e] outputDir=${ctx.outputDir}`);
    console.log(`[ios e2e] kinds=${result.artifacts.map((a) => a.kind).join(",")}`);
    console.log(`[ios e2e] notes=${JSON.stringify(result.notes)}`);
    expect(result.artifacts.some((a) => a.kind === "screenshot")).toBe(true);
    expect(result.artifacts.some((a) => a.kind === "gif")).toBe(true);
    if (expectVideo) expect(result.artifacts.some((a) => a.kind === "video")).toBe(true);
    expect(result.judgement).not.toBe("fail");
    return result;
  } finally {
    await collector.dispose?.(ctx);
  }
}

const macSh = (cmd: string) => {
  const dev = process.env.VIBE_MAC_DEVELOPER_DIR;
  const prefix = dev ? `export DEVELOPER_DIR='${dev}'; ` : "";
  return execFileSync("ssh", ["-o", "BatchMode=yes", process.env.VIBE_MAC_HOST!, prefix + cmd], {
    encoding: "utf8",
  });
};

describe.skipIf(!enabled)("ios collector on a real Mac", () => {
  it("dispose leaves a simulator that was already running alone", { timeout: 600_000 }, async () => {
    macSh(`xcrun simctl boot '${device}' 2>/dev/null; xcrun simctl bootstatus '${device}' >/dev/null`);
    try {
      await run({ device, app: { bundleId, launchArgs: [] } });
      expect(macSh("xcrun simctl list devices booted")).toContain(device);
    } finally {
      macSh(`xcrun simctl shutdown '${device}'`);
    }
  });

  it("captures screenshots, recording and crash check", { timeout: 600_000 }, async () => {
    await run({ device, app: { bundleId, launchArgs: [] } });
  });

  it.skipIf(!process.env.VIBE_E2E_IOS_APP)(
    "syncs a local .app, installs and launches it",
    { timeout: 600_000 },
    async () => {
      const result = await run({
        device,
        app: {
          bundleId: process.env.VIBE_E2E_IOS_APP_BUNDLE ?? "com.example.vibeverify.evidence",
          appPath: process.env.VIBE_E2E_IOS_APP,
          launchArgs: [],
        },
        steps: [{ type: "launch" }, { type: "screenshot", label: "after relaunch" }],
      });
      expect(result.notes.join("\n")).toMatch(/Synced/);
    },
  );

  it.skipIf(!process.env.VIBE_E2E_IOS_BUILD_CWD)(
    "builds on the Mac (app.build) and launches the product",
    { timeout: 1_200_000 },
    async () => {
      const result = await run({
        device,
        app: {
          bundleId: process.env.VIBE_E2E_IOS_APP_BUNDLE ?? "com.example.vibeverify.evidence",
          appPath: `build/Build/Products/Debug-iphonesimulator/${scheme}.app`,
          build: {
            cwd: process.env.VIBE_E2E_IOS_BUILD_CWD!,
            command: "xcodebuild",
            args: [
              "-scheme",
              scheme,
              "-sdk",
              "iphonesimulator",
              "-configuration",
              "Debug",
              "-derivedDataPath",
              "build",
              "CODE_SIGNING_ALLOWED=NO",
              "build",
            ],
            timeoutMs: 15 * 60_000,
          },
          launchArgs: [],
        },
      });
      expect(result.notes.join("\n")).toMatch(/Built on the Mac/);
    },
  );
});
