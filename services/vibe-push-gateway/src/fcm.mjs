import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const b64url = (b) => Buffer.from(b).toString("base64url");

/**
 * FCM HTTP v1 client. The service account JSON is supplied by the caller (never stored in the repo).
 * `fetchImpl`, the service account `token_uri` and `endpoint` are injectable so tests can use a fake FCM.
 */
export function createFcmClient({
  serviceAccount,
  fetchImpl = fetch,
  endpoint = "https://fcm.googleapis.com",
  now = Date.now,
}) {
  let cached = null; // { token, expiresAt }
  const tokenUrl = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";

  async function accessToken() {
    if (cached && cached.expiresAt - now() > 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const claims = {
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    };
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key);
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64url(signature)}`,
      }),
    });
    if (!res.ok) throw new Error(`oauth token request failed: ${res.status}`);
    const json = await res.json();
    cached = { token: json.access_token, expiresAt: now() + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  /** Returns { ok: true } or { ok: false, unregistered, status }. */
  async function send(message) {
    const res = await fetchImpl(
      `${endpoint}/v1/projects/${serviceAccount.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      },
    );
    if (res.ok) return { ok: true };
    const text = await res.text();
    return {
      ok: false,
      status: res.status,
      unregistered: res.status === 404 || /UNREGISTERED/.test(text),
    };
  }

  return { send };
}

/** FCM data values must be strings. */
export function buildFcmMessage({ token, title, body, data }) {
  const flat = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v !== undefined && v !== null) flat[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return {
    token,
    notification: { title, body },
    data: flat,
    android: { priority: "HIGH", notification: { channel_id: "default" } },
  };
}
