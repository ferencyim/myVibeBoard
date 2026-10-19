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
