// Real-Mac run over ssh. Off by default; enable with VIBE_E2E_IOS=1.
//   VIBE_MAC_HOST          ssh alias of the Mac (from the user's ~/.ssh/config; never committed)
//   VIBE_E2E_IOS_DEVICE    simulator name or UDID (default "iPhone 15")
//   VIBE_E2E_IOS_BUNDLE    bundle id to launch (default com.apple.Preferences, preinstalled)
// Pending: needs a Mac with Xcode (not yet installed).

import { describe, expect, it } from "vitest";
import { createNodeRunner } from "../../server/collectors/common";
import { createIosCollector } from "../../server/collectors/ios";
import { makeCtx } from "../helpers";

const enabled = process.env.VIBE_E2E_IOS === "1";

describe.skipIf(!enabled)("ios collector on a real Mac", () => {
  it("captures screenshots, recording and crash check", { timeout: 600_000 }, async () => {
    const collector = createIosCollector({
      config: {
        device: process.env.VIBE_E2E_IOS_DEVICE ?? "iPhone 15",
        app: { bundleId: process.env.VIBE_E2E_IOS_BUNDLE ?? "com.apple.Preferences", launchArgs: [] },
      },
    });
    const ctx = makeCtx({ projectType: "ios", runner: createNodeRunner() });
    const availability = await collector.detect(ctx);
    expect(availability.available, availability.reason).toBe(true);
    try {
      const result = await collector.collect(ctx);
      expect(result.artifacts.some((a) => a.kind === "screenshot")).toBe(true);
    } finally {
      await collector.dispose?.(ctx);
    }
  });
});
