import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { executableExists, findExecutable } from "./executable-resolution.js";
import { windowsExecutableResolution } from "./windows.js";
import { isPlatform } from "../test-utils/platform.js";

const originalEnv = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
};
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-executable-test-"));
  tempDirs.push(dir);
  return dir;
}

function prependPath(...dirs: string[]): void {
  process.env.PATH = [...dirs, originalEnv.PATH].filter(Boolean).join(path.delimiter);
}

function writeExecutable(filePath: string, content: string): string {
  writeFileSync(filePath, content);
  if (!isPlatform("win32")) {
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

function writeBrokenAbsoluteFixture(dir: string): string {
  const filePath = isPlatform("win32") ? path.join(dir, "broken.exe") : path.join(dir, "broken");
  writeFileSync(filePath, "not executable");
  if (!isPlatform("win32")) {
    chmodSync(filePath, 0o644);
  }
  return filePath;
}

function expectWindowsPathsEqual(actual: string | null, expected: string): void {
  expect(actual?.toLowerCase()).toBe(expected.toLowerCase());
}

afterEach(() => {
  process.env.PATH = originalEnv.PATH;
  process.env.PATHEXT = originalEnv.PATHEXT;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("findExecutable", () => {
  test.runIf(isPlatform("linux"))(
    "propagates a failed lookup process instead of reporting a missing executable",
    async () => {
      await expect(findExecutable("x".repeat(1024 * 1024))).rejects.toMatchObject({
        code: "E2BIG",
      });
    },
  );

  describe.skipIf(isPlatform("win32"))("POSIX", () => {
    test("finds an extensionless executable and skips an earlier non-executable candidate", async () => {
      const executableDir = makeTempDir();
      const nonExecutableDir = makeTempDir();
      const executable = writeExecutable(path.join(executableDir, "foo"), "#!/bin/sh\necho 0.1\n");
      const nonExecutable = path.join(nonExecutableDir, "foo");
      writeFileSync(nonExecutable, "#!/bin/sh\necho broken\n");
      chmodSync(nonExecutable, 0o644);
      prependPath(nonExecutableDir, executableDir);

      await expect(findExecutable("foo")).resolves.toBe(executable);
    });
  });

  describe.runIf(isPlatform("win32"))("Windows", () => {
    test("returns a working .cmd when an invalid .exe candidate appears first", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = [".EXE", ".CMD"].join(path.delimiter);
      const brokenExe = path.join(dir, "foo.exe");
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      writeFileSync(brokenExe, "");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("returns null when the only candidate is a broken .exe", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".EXE";
      writeFileSync(path.join(dir, "foo.exe"), "");
      prependPath(dir);

      await expect(findExecutable("foo")).resolves.toBeNull();
    });

    test("returns a .cmd when it is the only candidate", async () => {
      const dir = makeTempDir();
      process.env.PATHEXT = ".CMD";
      const cmd = writeExecutable(path.join(dir, "foo.cmd"), "@echo off\r\necho 0.1\r\n");
      prependPath(dir);

      expectWindowsPathsEqual(await findExecutable("foo"), cmd);
    });

    test("finds a .cmd for an extensionless absolute path", async () => {
      const dir = makeTempDir();
      const command = path.join(dir, "codex");
      const cmd = writeExecutable(`${command}.cmd`, "@echo off\r\necho 0.1\r\n");

      expectWindowsPathsEqual(await findExecutable(command), cmd);
    });

    test("does not probe fabricated absolute path extensions that do not exist", async () => {
      const dir = makeTempDir();
      const command = path.join(dir, "missing-command");

      await expect(findExecutable(command)).resolves.toBeNull();
    });

    test("finds a winget portable executable outside PATH", async () => {
      const originalLocalAppData = process.env.LOCALAPPDATA;
      const localAppData = makeTempDir();
      const packageDir = path.join(
        localAppData,
        "Microsoft",
        "WinGet",
        "Packages",
        "Anthropic.ClaudeCode_abc",
      );
      mkdirSync(packageDir, { recursive: true });
      const claude = path.join(packageDir, "claude.exe");
      copyFileSync(process.execPath, claude);
      process.env.LOCALAPPDATA = localAppData;
      process.env.PATH = makeTempDir();
      try {
        expectWindowsPathsEqual(await findExecutable("claude"), claude);
      } finally {
        process.env.LOCALAPPDATA = originalLocalAppData;
      }
    });
  });

  test("returns an invokable absolute path", async () => {
    await expect(findExecutable(process.execPath)).resolves.toBe(process.execPath);
  });

  test("returns null for an absolute path that cannot spawn", async () => {
    const dir = makeTempDir();
    const fixture = writeBrokenAbsoluteFixture(dir);

    await expect(findExecutable(fixture)).resolves.toBeNull();
  });

  test("returns null when the command is not on PATH", async () => {
    const dir = makeTempDir();
    prependPath(dir);

    await expect(findExecutable("paseo-definitely-missing-command")).resolves.toBeNull();
  });

  test("Windows resolution skips literal path candidates that do not exist", async () => {
    const probeExecutable = vi.fn(async () => true);

    await expect(
      windowsExecutableResolution.find("C:\\tools\\missing-command", {
        enumeratePathCandidates: async () => [],
        probeExecutable,
        exists: () => false,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBeNull();
    expect(probeExecutable).not.toHaveBeenCalled();
  });
});

describe("executableExists", () => {
  test("returns the path when it already exists", () => {
    const exists = (candidate: string) => candidate === "/usr/local/bin/codex";

    expect(executableExists("/usr/local/bin/codex", exists)).toBe("/usr/local/bin/codex");
  });

  test("on Windows, falls back to .exe, then .cmd for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.cmd";

      expect(executableExists("C:\\tools\\codex", exists)).toBe("C:\\tools\\codex.cmd");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("on Windows, ignores PowerShell scripts for extensionless paths", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    try {
      const exists = (candidate: string) => candidate === "C:\\tools\\codex.ps1";

      expect(executableExists("C:\\tools\\codex", exists)).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    }
  });

  test("returns null when no matching path exists", () => {
    expect(executableExists("/missing/codex", () => false)).toBeNull();
  });
});

describe("OpenCode desktop CLI resolution", () => {
  function desktopCli(appData: string, directory: string): string {
    const dir = path.join(appData, "ai.opencode.desktop", "cli", directory);
    mkdirSync(dir, { recursive: true });
    const cli = path.join(dir, "opencode-cli.exe");
    writeFileSync(cli, "fixture");
    return cli;
  }

  test("finds the newest valid desktop CLI for the current architecture outside PATH", async () => {
    const roamingAppData = makeTempDir();
    desktopCli(roamingAppData, "2.9.0-x64");
    const newest = desktopCli(roamingAppData, "2.10.0-x64");
    desktopCli(roamingAppData, "3.0.0-arm64");
    desktopCli(roamingAppData, "invalid-x64");
    const probeExecutable = vi.fn(async () => true);
    await expect(
      windowsExecutableResolution.find("opencode", {
        roamingAppData,
        arch: "x64",
        enumeratePathCandidates: async () => [],
        probeExecutable,
        exists: existsSync,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBe(newest);
    expect(probeExecutable).toHaveBeenCalledExactlyOnceWith(newest, 100);
  });

  test("keeps PATH and explicit commands ahead of the desktop CLI", async () => {
    const roamingAppData = makeTempDir();
    desktopCli(roamingAppData, "2.1.2-x64");
    const command = path.join(roamingAppData, "opencode.exe");
    writeFileSync(command, "fixture");
    const options = {
      roamingAppData,
      arch: "x64",
      enumeratePathCandidates: async () => [command],
      probeExecutable: vi.fn(async () => true),
      exists: existsSync,
      probeTimeoutMs: 100,
    };
    await expect(windowsExecutableResolution.find("opencode", options)).resolves.toBe(command);
    await expect(windowsExecutableResolution.find(command, options)).resolves.toBe(command);
    expect(options.probeExecutable.mock.calls).toEqual([
      [command, 100],
      [command, 100],
    ]);
  });

  test("skips a broken or incomplete update and tries the previous desktop CLI", async () => {
    const roamingAppData = makeTempDir();
    const working = desktopCli(roamingAppData, "2.1.2-arm64");
    desktopCli(roamingAppData, "2.2.0-arm64");
    mkdirSync(path.join(roamingAppData, "ai.opencode.desktop", "cli", "2.3.0-arm64"));
    await expect(
      windowsExecutableResolution.find("opencode", {
        roamingAppData,
        arch: "arm64",
        enumeratePathCandidates: async () => [],
        probeExecutable: async (candidate) => candidate === working,
        exists: existsSync,
        probeTimeoutMs: 100,
      }),
    ).resolves.toBe(working);
  });

  test("does not use the desktop CLI for a different command or missing explicit path", async () => {
    const roamingAppData = makeTempDir();
    desktopCli(roamingAppData, "2.1.2-x64");
    const options = {
      roamingAppData,
      arch: "x64",
      enumeratePathCandidates: async () => [],
      probeExecutable: vi.fn(async () => true),
      exists: existsSync,
      probeTimeoutMs: 100,
    };
    await expect(
      windowsExecutableResolution.find("different-command", options),
    ).resolves.toBeNull();
    await expect(
      windowsExecutableResolution.find(path.join(roamingAppData, "missing"), options),
    ).resolves.toBeNull();
    expect(options.probeExecutable).not.toHaveBeenCalled();
  });
});
