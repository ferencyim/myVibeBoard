import { describe, expect, it } from "vitest";
import {
  buildWindowsCaptureScript,
  createMacCapturer,
  createWindowsCapturer,
  defaultWindowCapturer,
} from "../../server/collectors/desktop";
import { createScriptedRunner } from "../../server/vibe/contract";

const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf16le");

describe("windows window capturer", () => {
  it("embeds pid, escaped title and output path in an -EncodedCommand script", async () => {
    const runner = createScriptedRunner(() => ({ stdout: "OK 800x600\n" }));
    const r = await createWindowsCapturer().capture(
      runner,
      { pid: 123, title: "it's ^Win" },
      "C:\\out\\it's.png",
    );
    expect(r).toEqual({ ok: true });
    const call = runner.calls[0];
    expect(call.command).toBe("powershell");
    expect(call.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const script = decode(String(call.args[5]));
    expect(script).toContain("[VibeWin]::Find(123, 'it''s ^Win')");
    expect(script).toContain("$bmp.Save('C:\\out\\it''s.png'");
    expect(script).toBe(buildWindowsCaptureScript({ pid: 123, title: "it's ^Win" }, "C:\\out\\it's.png"));
  });

  it("maps exit codes: no window vs real failure", async () => {
    const missing = createScriptedRunner(() => ({ exitCode: 2, stdout: "NO_WINDOW" }));
    expect(await createWindowsCapturer().capture(missing, { pid: 1 }, "x.png")).toMatchObject({
      ok: false,
      windowMissing: true,
    });
    const broken = createScriptedRunner(() => ({ exitCode: 1, stderr: "Add-Type failed" }));
    const r = await createWindowsCapturer().capture(broken, { pid: 1 }, "x.png");
    expect(r).toMatchObject({ ok: false, reason: "Add-Type failed" });
    expect((r as { windowMissing?: boolean }).windowMissing).toBeUndefined();
  });

  it("probe checks System.Drawing", async () => {
    const ok = createScriptedRunner(() => ({ stdout: "ok\n" }));
    expect(await createWindowsCapturer().probe(ok)).toEqual({ ok: true });
    const bad = createScriptedRunner(() => ({ exitCode: 1, stderr: "nope" }));
    expect(await createWindowsCapturer().probe(bad)).toMatchObject({ ok: false });
  });
});

describe("platform selection", () => {
  it("picks windows/mac capturers and none elsewhere", async () => {
    expect(defaultWindowCapturer("win32")).toBeDefined();
    expect(defaultWindowCapturer("linux")).toBeUndefined();
    const runner = createScriptedRunner(() => undefined);
    expect(await createMacCapturer().capture(runner, {}, "/o.png")).toEqual({ ok: true });
    expect(runner.calls[0]).toMatchObject({ command: "screencapture", args: ["-x", "/o.png"] });
  });
});
