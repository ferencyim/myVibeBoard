import { describe, expect, it } from "vitest";
import {
  RemoteMacExecutor,
  assertValidDeveloperDir,
  assertValidHost,
  assertValidRemotePath,
  shQuote,
} from "../../server/collectors/ios/remote-mac";
import { createScriptedRunner } from "../../server/vibe/contract";

describe("shQuote", () => {
  it("single-quotes and escapes embedded quotes", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(shQuote("a; rm -rf / $(x) `y`")).toBe("'a; rm -rf / $(x) `y`'");
  });
});

describe("validation", () => {
  it("rejects hosts that could inject ssh options or break scp", () => {
    expect(assertValidHost("mac-mini.local")).toBe("mac-mini.local");
    expect(() => assertValidHost("-oProxyCommand=evil")).toThrow();
    expect(() => assertValidHost("a b")).toThrow();
    expect(() => assertValidHost("host:22")).toThrow();
  });
  it("rejects unsafe remote paths", () => {
    expect(assertValidRemotePath("/tmp/vibe-verify/x-1/a.png")).toBeTruthy();
    expect(() => assertValidRemotePath("/tmp/a b")).toThrow();
    expect(() => assertValidRemotePath("/tmp/$(x)")).toThrow();
    expect(() => assertValidRemotePath("-rf")).toThrow();
  });
});

describe("RemoteMacExecutor", () => {
  const runner = () => createScriptedRunner(() => undefined);

  it("builds ssh command lines with BatchMode, timeout and quoted argv", async () => {
    const r = runner();
    const exec = new RemoteMacExecutor(r, "macbox");
    await exec.exec(["xcrun", "simctl", "launch", "iPhone 15", "com.x.app", "--flag=it's"], {
      timeoutMs: 1234,
    });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call.command).toBe("ssh");
    expect(call.args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "macbox",
      `'xcrun' 'simctl' 'launch' 'iPhone 15' 'com.x.app' '--flag=it'\\''s'`,
    ]);
    expect(call.options?.timeoutMs).toBe(1234);
  });

  it("uses scp with -- separators in both directions", async () => {
    const r = runner();
    const exec = new RemoteMacExecutor(r, "macbox", { scpPath: "myscp" });
    await exec.put("/local/App.app", "/tmp/w/App.app", { recursive: true });
    await exec.get("/tmp/w/a.png", "/out/a.png");
    expect(r.calls[0].command).toBe("myscp");
    expect(r.calls[0].args.slice(-4)).toEqual(["-r", "--", "/local/App.app", "macbox:/tmp/w/App.app"]);
    expect(r.calls[1].args.slice(-3)).toEqual(["--", "macbox:/tmp/w/a.png", "/out/a.png"]);
  });
});

describe("developerDir", () => {
  it("is exported before every remote command, quoted", async () => {
    const runner = createScriptedRunner(() => ({}));
    const mac = new RemoteMacExecutor(runner, "macbox", { developerDir: "/Volumes/My Disk/X.app/Contents/Developer" });
    await mac.exec(["xcrun", "simctl", "list"]);
    await mac.shell("cd '/tmp' && xcodebuild -version");
    const cmds = runner.calls.map((c) => String(c.args[c.args.length - 1]));
    expect(cmds[0]).toBe("export DEVELOPER_DIR='/Volumes/My Disk/X.app/Contents/Developer'; 'xcrun' 'simctl' 'list'");
    expect(cmds[1]).toMatch(/^export DEVELOPER_DIR='[^']+'; cd '\/tmp' && xcodebuild/);
  });
  it("leaves commands untouched without it and rejects relative paths", async () => {
    const runner = createScriptedRunner(() => ({}));
    await new RemoteMacExecutor(runner, "macbox").shell("uname");
    expect(runner.calls[0].args[runner.calls[0].args.length - 1]).toBe("uname");
    expect(() => assertValidDeveloperDir("relative/dir")).toThrow();
    expect(() => assertValidDeveloperDir("/a\nb")).toThrow();
  });
});
