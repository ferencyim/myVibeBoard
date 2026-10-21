import { createHash, randomUUID } from "node:crypto";

// Official docs: https://dev.vivo.com.cn/documentCenter/doc/362 (PUSH UPS server API).
// Signature, field limits and result codes below follow that document.
const AUTH_FAILED = 10000; // permission authentication failed (bad or expired authToken)
const REGID_INVALID = 10302; // regId invalid / expired
const MAX_CUSTOM_PAIRS = 10;
const MAX_CUSTOM_CHARS = 1024;
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const md5 = (s) => createHash("md5").update(s).digest("hex");

/**
 * vivo server push client (single push by regId).
 * `pushMode` 1 = test push (only reaches registered test devices), 0 = production.
 * `fetchImpl`, `endpoint` and `now` are injectable for tests.
 */
export function createVivoClient({
  appId,
  appKey,
  appSecret,
  pushMode = 0,
  fetchImpl = fetch,
  endpoint = "https://api-push.vivo.com.cn",
  now = Date.now,
}) {
  if (!appId || !appKey || !appSecret) throw new Error("vivo appId, appKey and appSecret are required");
  const TOKEN_REFRESH_MS = 60 * 60 * 1000; // tokens live 24h; the docs advise refreshing every 1-2h
  let cached = null; // { token, fetchedAt }

  async function authToken(force = false) {
    if (!force && cached && now() - cached.fetchedAt < TOKEN_REFRESH_MS) return cached.token;
    const timestamp = now();
    const res = await fetchImpl(`${endpoint}/message/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId,
        appKey,
        timestamp,
        sign: md5(`${appId}${appKey}${timestamp}${appSecret}`),
      }),
    });
    if (!res.ok) throw new Error(`vivo auth request failed: ${res.status}`);
    const json = await res.json();
    if (json.result !== 0 || !json.authToken) {
      throw new Error(`vivo auth rejected: result=${json.result}`);
    }
    cached = { token: json.authToken, fetchedAt: now() };
    return cached.token;
  }

  async function post(message, token) {
    const res = await fetchImpl(`${endpoint}/message/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authToken: token },
      body: JSON.stringify(message),
    });
    if (!res.ok) return { httpStatus: res.status, json: {} };
    return { httpStatus: res.status, json: await res.json() };
  }

  /** Returns { ok: true } or { ok: false, unregistered, status }. */
  async function send(message) {
    const body = { ...message, appId: Number(appId) || appId, pushMode };
    let out = await post(body, await authToken());
    if (out.json.result === AUTH_FAILED) out = await post(body, await authToken(true));
    const { json, httpStatus } = out;
    if (json.result === 0) {
      const bad = (json.invalidUsers ?? []).find((u) => u.status === 1 || u.status === 2);
      return bad ? { ok: false, status: bad.status, unregistered: true } : { ok: true };
    }
    return {
      ok: false,
      status: json.result ?? httpStatus,
      unregistered: json.result === REGID_INVALID,
    };
  }

  return { send };
}

/**
 * vivo single-push message. skipType 3 = click handled by the app's receiver, which gets the
 * custom map back (so a tap routes exactly like an FCM data message).
 */
export function buildVivoMessage({ token, title, body, data, requestId }) {
  const custom = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v === undefined || v === null) continue;
    if (Object.keys(custom).length >= MAX_CUSTOM_PAIRS) break;
    custom[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  // Drop trailing pairs until the map fits the 1024 character limit.
  const keys = Object.keys(custom);
  while (keys.length > 0 && JSON.stringify(custom).length > MAX_CUSTOM_CHARS) delete custom[keys.pop()];
  return {
    regId: token,
    notifyType: 4,
    title: clip(title, 40),
    content: clip(body, 100),
    timeToLive: 86400,
    skipType: 3,
    clientCustomMap: custom,
    requestId: typeof requestId === "string" && requestId && requestId.length <= 64 ? requestId : randomUUID().replaceAll("-", ""),
  };
}
