import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { buildFcmMessage } from "./fcm.mjs";
import { buildVivoMessage } from "./vivo.mjs";

const MAX_BODY = 16 * 1024;

function authorized(header, expected) {
  const a = Buffer.from(header ?? "");
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /v1/push {token,title,body,data,channel?} with `Authorization: Bearer <authToken>`.
 * `channel` is "fcm" (default, also when absent) or "vivo".
 * No FCM and no vivo client means dry-run: the message is logged, not sent.
 * Responses: 200 {ok,dryRun?}, 400, 401, 404 (token unregistered), 502 (provider error),
 * 503 (the requested channel has no credentials on this gateway).
 */
export function createGateway({ authToken, fcm = null, vivo = null, log = console.log }) {
  const dryRun = !fcm && !vivo;
  const channels = { fcm, vivo };
  if (!authToken) throw new Error("authToken is required");
  return createServer(async (req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/healthz") return reply(200, { ok: true, dryRun, channels: { fcm: !!fcm, vivo: !!vivo } });
    if (req.method !== "POST" || req.url !== "/v1/push") return reply(404, { error: "not_found" });
    if (!authorized(req.headers.authorization, authToken)) {
      return reply(401, { error: "unauthorized" });
    }

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return reply(400, { error: "too_large" });
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return reply(400, { error: "bad_json" });
    }
    if (
      typeof input?.token !== "string" ||
      !input.token ||
      typeof input.title !== "string" ||
      typeof input.body !== "string"
    ) {
      return reply(400, { error: "bad_request" });
    }

    const channel = input.channel ?? "fcm";
    if (channel !== "fcm" && channel !== "vivo") return reply(400, { error: "bad_channel" });
    const message =
      channel === "vivo"
        ? buildVivoMessage({ ...input, requestId: input.requestId })
        : buildFcmMessage(input);
    if (dryRun) {
      const id = message.token ?? message.regId;
      const shown = { channel, ...message, ...(message.token ? { token: `${id.slice(0, 8)}...` } : { regId: `${id.slice(0, 8)}...` }) };
      log(`[dry-run] would send ${JSON.stringify(shown)}`);
      return reply(200, { ok: true, dryRun: true });
    }
    const client = channels[channel];
    if (!client) return reply(503, { error: "channel_unavailable", channel });
    try {
      const result = await client.send(message);
      if (result.ok) return reply(200, { ok: true });
      if (result.unregistered) return reply(404, { error: "unregistered" });
      return reply(502, { error: `${channel}_error`, status: result.status });
    } catch (err) {
      log(`${channel} send failed: ${err?.message}`);
      return reply(502, { error: `${channel}_unreachable` });
    }
  });
}
