// Window screenshots behind a Runner. Windows: a PowerShell script (user32 PrintWindow +
// System.Drawing) finds the top-level window of a pid / title regex and saves it as PNG.
// macOS: full-screen `screencapture` (degraded). Other platforms: not supported (inject your own).

import type { Runner } from "../../vibe/contract";

export interface WindowTarget {
  pid?: number;
  /** Regex source matched against window titles. */
  title?: string;
}

export type CaptureResult = { ok: true } | { ok: false; reason: string; windowMissing?: boolean };

export interface WindowCapturer {
  /** Cheap capability probe; `degraded` explains a fallback. */
  probe(runner: Runner): Promise<{ ok: true; degraded?: string } | { ok: false; reason: string }>;
  /** Writes a PNG of the target's window to `outFile`. */
  capture(runner: Runner, target: WindowTarget, outFile: string): Promise<CaptureResult>;
}

const psq = (s: string) => `'${s.replaceAll("'", "''")}'`;

export const WINDOWS_NO_WINDOW_EXIT = 2;

export function buildWindowsCaptureScript(target: WindowTarget, outFile: string): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class VibeWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  // Match the target's DPI awareness so window rect and PrintWindow agree (unaware apps are virtualized).
  public static void MatchDpi(IntPtr h) {
    int a = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(h));
    SetThreadDpiAwarenessContext(a == 0 ? new IntPtr(-1) : new IntPtr(-4));
  }
  public static IntPtr Find(uint pid, string title) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      bool ok = (title != "" && Regex.IsMatch(t, title)) || (title == "" && pid != 0 && p == pid);
      if (!ok) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.R - r.L) * (r.B - r.T);
      if (area > 2500 && area > bestArea) { best = h; bestArea = area; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
$h = [VibeWin]::Find(${target.pid ?? 0}, ${psq(target.title ?? "")})
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit ${WINDOWS_NO_WINDOW_EXIT} }
[VibeWin]::MatchDpi($h)
$r = New-Object VibeWin+RECT
[void][VibeWin]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [VibeWin]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
if (-not $ok) { $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size) }
$g.Dispose()
$bmp.Save(${psq(outFile)}, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "OK $($w)x$($ht)"
`;
}

/** Windows PowerShell -EncodedCommand payload (UTF-16LE base64). */
export const encodePowerShell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

export function createWindowsCapturer(): WindowCapturer {
  const ps = (script: string) => [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShell(script),
  ];
  return {
    async probe(runner) {
      const r = await runner.run("powershell", ps("Add-Type -AssemblyName System.Drawing; 'ok'"), {
        timeoutMs: 30_000,
      });
      return r.exitCode === 0 && r.stdout.includes("ok")
        ? { ok: true }
        : {
            ok: false,
            reason: `PowerShell with System.Drawing is not usable: ${r.stderr.trim().slice(0, 200)}`,
          };
    },
    async capture(runner, target, outFile) {
      const r = await runner.run("powershell", ps(buildWindowsCaptureScript(target, outFile)), {
        timeoutMs: 60_000,
      });
      if (r.exitCode === 0 && r.stdout.includes("OK ")) return { ok: true };
      if (r.exitCode === WINDOWS_NO_WINDOW_EXIT) {
        return { ok: false, reason: "no matching window", windowMissing: true };
      }
      return { ok: false, reason: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.exitCode}` };
    },
  };
}

/** macOS fallback: whole-screen capture (no per-window selection without extra tooling). */
export function createMacCapturer(): WindowCapturer {
  return {
    async probe() {
      return { ok: true, degraded: "macOS: full-screen screencapture instead of a window capture" };
    },
    async capture(runner, _target, outFile) {
      const r = await runner.run("screencapture", ["-x", outFile], { timeoutMs: 30_000 });
      return r.exitCode === 0 ? { ok: true } : { ok: false, reason: r.stderr.trim().slice(0, 300) };
    },
  };
}

export function defaultWindowCapturer(
  platform: NodeJS.Platform = process.platform,
): WindowCapturer | undefined {
  if (platform === "win32") return createWindowsCapturer();
  if (platform === "darwin") return createMacCapturer();
  return undefined;
}
