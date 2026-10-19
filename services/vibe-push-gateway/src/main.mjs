import { readFileSync } from "node:fs";
import { createFcmClient } from "./fcm.mjs";
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
// No credentials (or explicit flag) => dry-run: log the message, send nothing.
const dryRun = env.VIBE_PUSH_DRY_RUN === "1" || process.argv.includes("--dry-run") || !serviceAccount;
const fcm = dryRun
  ? null
  : createFcmClient({ serviceAccount, endpoint: env.VIBE_PUSH_FCM_ENDPOINT || undefined });

const host = env.HOST || "127.0.0.1";
const port = Number(env.PORT || 8787);
createGateway({ authToken, fcm }).listen(port, host, () => {
  const mode = dryRun ? "DRY-RUN, nothing is sent" : "FCM live";
  console.log(`vibe-push-gateway listening on ${host}:${port} (${mode})`);
});
