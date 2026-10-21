import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createFcmClient } from "../src/fcm.mjs";
import { createGateway } from "../src/gateway.mjs";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );

const post = (url, body, token = "secret") =>
  fetch(`${url}/v1/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const msg = {
  token: "fcm-token-123456",
  title: "myProject",
  body: "Needs your approval",
  data: { agentId: "a1", n: 2 },
};

test("rejects missing or wrong bearer token", async () => {
  const gw = createGateway({ authToken: "secret", log: () => {} });
  const url = await listen(gw);
  assert.equal((await post(url, msg, null)).status, 401);
  assert.equal((await post(url, msg, "nope")).status, 401);
  gw.close();
});

test("dry-run logs the message and sends nothing", async () => {
  const logs = [];
  const gw = createGateway({ authToken: "secret", fcm: null, log: (l) => logs.push(l) });
  const url = await listen(gw);
  const res = await post(url, msg);
  assert.deepEqual(await res.json(), { ok: true, dryRun: true });
  assert.match(logs[0], /dry-run/);
  assert.match(logs[0], /myProject/);
  assert.doesNotMatch(logs[0], /fcm-token-123456/); // token is truncated in logs
  gw.close();
});

test("validates request body", async () => {
  const gw = createGateway({ authToken: "secret", log: () => {} });
  const url = await listen(gw);
  assert.equal((await post(url, { token: "x" })).status, 400);
  gw.close();
});

test("sends minimal-body message to fake FCM with OAuth token; maps unregistered to 404", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const seen = [];
  const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, raw });
      if (req.url === "/token") {
        return res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }));
      }
      const m = JSON.parse(raw).message;
      if (m.token === "dead") {
        res.statusCode = 404;
        return res.end('{"error":{"status":"UNREGISTERED"}}');
      }
      res.end("{}");
    });
  });
  const fakeUrl = await listen(fake);
  const fcm = createFcmClient({
    serviceAccount: {
      project_id: "proj",
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: `${fakeUrl}/token`,
    },
    endpoint: fakeUrl,
  });
  const gw = createGateway({ authToken: "secret", fcm, log: () => {} });
  const url = await listen(gw);

  assert.equal((await post(url, msg)).status, 200);
  const sent = seen.find((s) => s.url === "/v1/projects/proj/messages:send");
  assert.equal(sent.auth, "Bearer at");
  const m = JSON.parse(sent.raw).message;
  assert.deepEqual(m.notification, { title: "myProject", body: "Needs your approval" });
  assert.deepEqual(m.data, { agentId: "a1", n: "2" });

  assert.equal((await post(url, { ...msg, token: "dead" })).status, 404);
  gw.close();
  fake.close();
});

// ---- vivo channel ----
import { createHash } from "node:crypto";
import { createVivoClient, buildVivoMessage } from "../src/vivo.mjs";

function fakeVivo(handlers = {}) {
  const seen = [];
  let authCount = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, authToken: req.headers.authtoken, body });
      if (req.url === "/message/auth") {
        authCount += 1;
        return res.end(JSON.stringify({ result: 0, desc: "success", authToken: `tok${authCount}` }));
      }
      res.end(JSON.stringify(handlers.send?.(body, req.headers.authtoken) ?? { result: 0 }));
    });
  });
  return { server, seen, authCount: () => authCount };
}

const vivoCreds = { appId: "105", appKey: "key", appSecret: "sec" };

test("vivo auth signs md5(appId+appKey+timestamp+appSecret) and caches the token", async () => {
  let t = 1_700_000_000_000;
  const f = fakeVivo();
  const url = await listen(f.server);
  const vivo = createVivoClient({ ...vivoCreds, pushMode: 1, endpoint: url, now: () => t });
  await vivo.send(buildVivoMessage({ token: "reg1", title: "p", body: "b" }));
  t += 30 * 60_000;
  await vivo.send(buildVivoMessage({ token: "reg1", title: "p", body: "b" }));
  assert.equal(f.authCount(), 1);
  const auth = f.seen.find((s) => s.url === "/message/auth").body;
  const expected = createHash("md5").update(`105key${auth.timestamp}sec`).digest("hex");
  assert.equal(auth.sign, expected);
  assert.equal(auth.appId, "105");
  t += 40 * 60_000; // past the 1h refresh window
  await vivo.send(buildVivoMessage({ token: "reg1", title: "p", body: "b" }));
  assert.equal(f.authCount(), 2);
  const sends = f.seen.filter((s) => s.url === "/message/send");
  assert.equal(sends[0].authToken, "tok1");
  assert.equal(sends[2].authToken, "tok2");
  assert.equal(sends[0].body.pushMode, 1);
  assert.equal(sends[0].body.regId, "reg1");
  f.server.close();
});

test("vivo re-authenticates once when the token is rejected", async () => {
  const f = fakeVivo({ send: (_b, tok) => (tok === "tok1" ? { result: 10000 } : { result: 0 }) });
  const url = await listen(f.server);
  const vivo = createVivoClient({ ...vivoCreds, endpoint: url });
  assert.deepEqual(await vivo.send(buildVivoMessage({ token: "r", title: "p", body: "b" })), { ok: true });
  assert.equal(f.authCount(), 2);
  f.server.close();
});

test("vivo message: minimal fields, limits, unique requestId, string custom map", () => {
  const a = buildVivoMessage({ token: "r", title: "t".repeat(60), body: "b".repeat(200), data: { agentId: "a1", n: 2 } });
  const b = buildVivoMessage({ token: "r", title: "t", body: "b" });
  assert.equal(a.title.length, 40);
  assert.equal(a.content.length, 100);
  assert.deepEqual(a.clientCustomMap, { agentId: "a1", n: "2" });
  assert.notEqual(a.requestId, b.requestId);
  assert.ok(a.requestId.length <= 64);
});

test("gateway routes channel=vivo, maps 10302 to 404, other codes to 502", async () => {
  const f = fakeVivo({
    send: (b) => (b.regId === "dead" ? { result: 10302 } : b.regId === "limit" ? { result: 10070 } : { result: 0 }),
  });
  const fakeUrl = await listen(f.server);
  const vivo = createVivoClient({ ...vivoCreds, endpoint: fakeUrl });
  const gw = createGateway({ authToken: "secret", vivo, log: () => {} });
  const url = await listen(gw);
  assert.equal((await post(url, { ...msg, token: "ok", channel: "vivo" })).status, 200);
  assert.equal((await post(url, { ...msg, token: "dead", channel: "vivo" })).status, 404);
  const limited = await post(url, { ...msg, token: "limit", channel: "vivo" });
  assert.equal(limited.status, 502);
  assert.equal((await limited.json()).status, 10070);
  // fcm is not configured on this gateway
  assert.equal((await post(url, msg)).status, 503);
  assert.equal((await post(url, { ...msg, channel: "xx" })).status, 400);
  gw.close();
  f.server.close();
});

test("without a vivo client a vivo request is unavailable while fcm keeps working", async () => {
  const fcm = { send: async () => ({ ok: true }) };
  const gw = createGateway({ authToken: "secret", fcm, log: () => {} });
  const url = await listen(gw);
  assert.equal((await post(url, msg)).status, 200);
  assert.equal((await post(url, { ...msg, channel: "fcm" })).status, 200);
  assert.equal((await post(url, { ...msg, channel: "vivo" })).status, 503);
  gw.close();
});

test("dry-run also covers vivo and truncates the regId", async () => {
  const logs = [];
  const gw = createGateway({ authToken: "secret", log: (l) => logs.push(l) });
  const url = await listen(gw);
  const res = await post(url, { ...msg, token: "vivo-reg-id-123456", channel: "vivo" });
  assert.deepEqual(await res.json(), { ok: true, dryRun: true });
  assert.match(logs[0], /vivo/);
  assert.doesNotMatch(logs[0], /vivo-reg-id-123456/);
  gw.close();
});
