import { describe, expect, test } from "vitest";

import { assertDirectListenAuth, parseListenString } from "./bootstrap.js";

const check = (listen: string, password?: string, env: NodeJS.ProcessEnv = {}) =>
  assertDirectListenAuth({
    listenTarget: parseListenString(listen),
    auth: password ? { password } : undefined,
    env,
  });

describe("assertDirectListenAuth", () => {
  test("allows loopback listeners without a password", () => {
    expect(() => check("127.0.0.1:6767")).not.toThrow();
    expect(() => check("[::1]:6767")).not.toThrow();
    expect(() => check("localhost:6767")).not.toThrow();
    expect(() => check("6767")).not.toThrow();
  });

  test("allows unix sockets and pipes without a password", () => {
    expect(() => check("unix:///tmp/paseo.sock")).not.toThrow();
    expect(() => check("pipe://paseo")).not.toThrow();
  });

  test("rejects non-loopback listeners without a password", () => {
    expect(() => check("0.0.0.0:6767")).toThrow(/without a daemon password/);
    expect(() => check("192.168.1.5:6767")).toThrow(/without a daemon password/);
    expect(() => check("[::]:6767")).toThrow(/without a daemon password/);
  });

  test("allows non-loopback listeners when a password is set", () => {
    expect(() => check("0.0.0.0:6767", "$2b$hash")).not.toThrow();
  });

  test("allows non-loopback listeners with explicit override", () => {
    expect(() =>
      check("0.0.0.0:6767", undefined, { PASEO_ALLOW_INSECURE_LISTEN: "1" }),
    ).not.toThrow();
  });
});
