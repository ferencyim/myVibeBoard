import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import {
  isRecentAttention,
  resolvePushConfig,
  toMinimalPayload,
  toPluginPayload,
  withAgentTarget,
} from "./push-config.js";
import { PushService } from "./push-service.js";

const logger = (() => {
  const l = {
    child: () => l,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return l as unknown as pino.Logger;
})();

describe("plugin notifications", () => {
  test("minimal mode clips text and drops everything but short string data", () => {
    const payload = toPluginPayload(
      {
        title: "My project",
        body: "x".repeat(200),
        data: { cardKey: "VB-1", card: { title: "secret" }, note: "n".repeat(100), n: 3 },
      },
      true,
    );
    expect(payload).toEqual({
      title: "My project",
      body: "x".repeat(40),
      data: { cardKey: "VB-1" },
    });
  });

  test("without minimal mode the payload passes through", () => {
    const input = { title: "T", body: "B".repeat(100), data: { a: { b: 1 } } };
    expect(toPluginPayload(input, false)).toEqual(input);
  });

  test("agent attention pushes get the daemon's own target fields, kept under minimal mode", () => {
    const target = { serverId: "srv-1", workspaceId: "ws-1", agentId: "agent-1" };
    const notification = withAgentTarget(
      { title: "T", body: "B", data: { event: "session.waiting", cardKey: "VB-1" } },
      target,
    );
    expect(toPluginPayload(notification, true).data).toEqual({
      ...target,
      event: "session.waiting",
      cardKey: "VB-1",
    });
  });

  test("an attention Paseo handled recently is a duplicate; an old or other one is not", () => {
    const recent = new Map([["a1:permission", 1_000]]);
    expect(isRecentAttention(recent, "a1", "permission", 30_000)).toBe(true);
    expect(isRecentAttention(recent, "a1", "permission", 1_000 + 3 * 60_000)).toBe(false);
    expect(isRecentAttention(recent, "a1", "finished", 30_000)).toBe(false);
    expect(isRecentAttention(recent, "a2", "permission", 30_000)).toBe(false);
  });
});

describe("resolvePushConfig", () => {
  test("without config behaves like upstream", () => {
    expect(resolvePushConfig(undefined, {})).toEqual({ gateway: undefined, minimalPayload: false });
  });

  test("gateway enables minimal payload by default and env token wins", () => {
    const cfg = resolvePushConfig(
      { push: { gateway: "http://127.0.0.1:8787", gatewayToken: "file" } },
      { PASEO_PUSH_GATEWAY_TOKEN: "env" },
    );
    expect(cfg).toEqual({
      gateway: { url: "http://127.0.0.1:8787", authToken: "env" },
      minimalPayload: true,
    });
  });
});

describe("minimal payload", () => {
  test("contains only project name and event type, no assistant text", () => {
    const payload = toMinimalPayload(
      {
        title: "Agent finished",
        body: "SECRET assistant preview",
        data: { serverId: "s", agentId: "a", workspaceId: "w", reason: "permission" },
      },
      "myProject",
    );
    expect(payload.title).toBe("myProject");
    expect(payload.body).toBe("Needs your approval");
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });
});

describe("PushService gateway delivery", () => {
  test("posts native tokens with bearer auth and revokes on 404", async () => {
    const seen: Array<{ auth?: string; body: Record<string, unknown> }> = [];
    const respond = (req: IncomingMessage, res: ServerResponse, raw: string) => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ auth: req.headers.authorization, body });
      res.statusCode = body.token === "gone" ? 404 : 200;
      res.end("{}");
    };
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      respond(req, res, raw);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const revoked: string[] = [];
    const service = new PushService(logger, (t) => revoked.push(t), { url, authToken: "tok" });

    await service.sendPush(["fcm-1", "gone"], { title: "P", body: "Finished", data: { a: 1 } });
    server.close();

    expect(seen.map((s) => s.auth)).toEqual(["Bearer tok", "Bearer tok"]);
    expect(seen[0].body).toEqual({ token: "fcm-1", title: "P", body: "Finished", data: { a: 1 } });
    expect(revoked).toEqual(["gone"]);
  });
});
