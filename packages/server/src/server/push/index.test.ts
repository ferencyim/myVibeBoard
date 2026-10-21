import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { createPushNotifications } from "./index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("push notifications", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an offline device stops receiving notifications after 48 hours", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[offline-device]");
    now += 48 * 60 * 60 * 1000;
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ subscriptions: [] });
  });

  test("online revocation stops notifications immediately", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[online-device]");
    pushNotifications.revoke("ExponentPushToken[online-device]");
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
  });

  test("remembers the vivo channel across restarts; fcm-only stays channel-free", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    const now = Date.parse("2026-08-10T00:00:00.000Z");
    const first = createPushNotifications({ logger: createLogger(), filePath, now: () => now });
    first.renew("fcm-device");
    expect(readFileSync(filePath, "utf8")).not.toContain("channel");
    first.renew("vivo-reg", "vivo");

    const seen: Array<{ tokens: string[]; channels?: ReadonlyMap<string, string> }> = [];
    const second = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens, _payload, channels) => void seen.push({ tokens, channels }),
    });
    await second.send({ title: "P", body: "B" });
    expect(seen[0].tokens.sort()).toEqual(["fcm-device", "vivo-reg"]);
    expect([...(seen[0].channels ?? [])]).toEqual([["vivo-reg", "vivo"]]);

    second.revoke("vivo-reg");
    await second.send({ title: "P", body: "B" });
    expect(seen[1].tokens).toEqual(["fcm-device"]);
    expect(seen[1].channels).toBeUndefined();
  });
});
