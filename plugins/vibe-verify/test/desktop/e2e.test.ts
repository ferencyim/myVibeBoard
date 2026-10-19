// Real window capture on this machine. Off by default; enable with VIBE_E2E_DESKTOP=1 (Windows).
// Launches a tiny WinForms window through PowerShell (title "VibeE2E Window") with the real
// launcher + window capturer, and stops only the process it started.

import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createNodeRunner } from "../../server/collectors/common";
import { createDesktopCollector } from "../../server/collectors/desktop";
import { makeCtx } from "../helpers";

const enabled = process.env.VIBE_E2E_DESKTOP === "1" && process.platform === "win32";

const FORM = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f = New-Object System.Windows.Forms.Form",
  "$f.Text = 'VibeE2E Window'; $f.Width = 420; $f.Height = 280",
  "$l = New-Object System.Windows.Forms.Label; $l.Text = 'vibe desktop e2e'; $l.AutoSize = $true",
  "$f.Controls.Add($l)",
  "$t = New-Object System.Windows.Forms.Timer; $t.Interval = 90000; $t.Add_Tick({ $f.Close() }); $t.Start()",
  "[void]$f.ShowDialog()",
].join("; ");

describe.skipIf(!enabled)("desktop collector on a real window", () => {
  it("captures the window screenshot, GIF and logs", { timeout: 120_000 }, async () => {
    const collector = createDesktopCollector({
      config: {
        app: {
          command: "powershell",
          args: ["-NoProfile", "-STA", "-Command", FORM],
          windowTitle: "^VibeE2E Window$",
          windowTimeoutMs: 45_000,
          settleMs: 500,
          automation: "none",
        },
        steps: [{ type: "wait", ms: 300 }, { type: "screenshot", label: "again" }],
      },
    });
    const ctx = makeCtx({ projectType: "desktop", runner: createNodeRunner() });
    expect(await collector.detect(ctx)).toEqual({ available: true });
    try {
      const result = await collector.collect(ctx);
      expect(result.notes.join("\n")).not.toContain("no window");
      expect(result.judgement).toBeUndefined();
      const shots = result.artifacts.filter((a) => a.kind === "screenshot");
      expect(shots.length).toBeGreaterThanOrEqual(3);
      for (const s of shots) {
        expect(existsSync(s.path)).toBe(true);
        expect(statSync(s.path).size).toBeGreaterThan(500);
      }
      expect(result.artifacts.some((a) => a.kind === "gif")).toBe(true);
    } finally {
      await collector.dispose?.(ctx);
    }
  });
});
