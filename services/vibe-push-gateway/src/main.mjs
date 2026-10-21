import { readFileSync } from "node:fs";
import { createFcmClient } from "./fcm.mjs";
import { createVivoClient } from "./vivo.mjs";
import { createGateway } from "./gateway.mjs";

const env = process.env;
const authToken = env.VIBE_PUSH_AUTH_TOKEN;
if (!authToken) {
  console.error("VIBE_PUSH_AUTH_TOKEN is required");
  process.exit(1);
}

let serviceAccount = null;
if (env.VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE) {
  serviceAccount = JSON.parse(readFileSync(env.VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE, "utf8"));
} else if (env.VIBE_PUSH_FCM_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(env.VIBE_PUSH_FCM_SERVICE_ACCOUNT_JSON);
}
// vivo is optional: all of VIVO_APP_ID / VIVO_APP_KEY / VIVO_APP_SECRET are needed, else the channel is off.
const vivoEnabled = !!(env.VIVO_APP_ID && env.VIVO_APP_KEY && env.VIVO_APP_SECRET);
const vivo =
  vivoEnabled && env.VIBE_PUSH_DRY_RUN !== "1" && !process.argv.includes("--dry-run")
    ? createVivoClient({
        appId: env.VIVO_APP_ID,
        appKey: env.VIVO_APP_KEY,
        appSecret: env.VIVO_APP_SECRET,
        pushMode: Number(env.VIVO_PUSH_MODE || 0),
        endpoint: env.VIBE_PUSH_VIVO_ENDPOINT || undefined,
      })
    : null;

// No credentials (or explicit flag) => dry-run: log the message, send nothing.
const forcedDryRun = env.VIBE_PUSH_DRY_RUN === "1" || process.argv.includes("--dry-run");
const dryRun = forcedDryRun || (!serviceAccount && !vivoEnabled);
const fcm = forcedDryRun || !serviceAccount
  ? null
  : createFcmClient({ serviceAccount, endpoint: env.VIBE_PUSH_FCM_ENDPOINT || undefined });

const host = env.HOST || "127.0.0.1";
const port = Number(env.PORT || 8787);
createGateway({ authToken, fcm, vivo }).listen(port, host, () => {
  const mode = dryRun
    ? "DRY-RUN, nothing is sent"
    : `live: fcm=${fcm ? "on" : "off"} vivo=${vivo ? `on(pushMode=${env.VIVO_PUSH_MODE || 0})` : "off"}`;
  console.log(`vibe-push-gateway listening on ${host}:${port} (${mode})`);
});
