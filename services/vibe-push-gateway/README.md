# vibe-push-gateway

Tiny Node service (no dependencies) between the Paseo daemon and FCM HTTP v1.
Deployed on the same host as the relay behind its own reverse-proxy location (e.g. `/push/`); see WP-48.

## API

`POST /v1/push` with `Authorization: Bearer <VIBE_PUSH_AUTH_TOKEN>` and JSON `{token,title,body,data}`.
Responses: 200, 400 bad body, 401 bad auth, 404 FCM token unregistered (daemon then drops the token),
502 FCM failure. `GET /healthz` reports `{ok,dryRun}`.

The daemon sends only `title = <project name>` and `body = <event type>` (minimal payload); real content is
fetched by the app over the encrypted channel after opening.

## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `VIBE_PUSH_AUTH_TOKEN` | Required. Shared secret the daemon presents. |
| `VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE` | Path to the Firebase service-account JSON (kept outside the repo). |
| `VIBE_PUSH_FCM_SERVICE_ACCOUNT_JSON` | Alternative: the JSON content itself. |
| `VIBE_PUSH_DRY_RUN=1` / `--dry-run` | Force dry-run. Dry-run is also automatic when no service account is given. |
| `VIBE_PUSH_FCM_ENDPOINT` | Override FCM base URL (tests). |
| `HOST` (127.0.0.1), `PORT` (8787) | Listen address. |

Dry-run logs the message that would be sent (token truncated) and sends nothing.

## Run

    VIBE_PUSH_AUTH_TOKEN=<secret> node src/main.mjs            # dry-run
    VIBE_PUSH_AUTH_TOKEN=<secret> VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE=<path> node src/main.mjs
    docker build -t vibe-push-gateway . && docker run -p 127.0.0.1:8787:8787 -e VIBE_PUSH_AUTH_TOKEN=<secret> \
      -v <host-path>/sa.json:/secrets/sa.json:ro -e VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE=/secrets/sa.json vibe-push-gateway

Tests: `npm test`.

## Daemon side (`~/.paseo/config.json`)

    "daemon": { "push": { "gateway": "https://<RELAY_DOMAIN>/push", "minimalPayload": true } }

Token: env `PASEO_PUSH_GATEWAY_TOKEN` on the daemon (or `daemon.push.gatewayToken`). Without `daemon.push`,
behaviour is identical to upstream (Expo push, full preview text). `minimalPayload` defaults to true once a gateway is set.

## Credentials the user provides (never committed)

1. Firebase project -> Android app (package id of the app) -> download `google-services.json`; place it at
   `packages/app/.secrets/google-services.prod.json` (or `.debug.json`; or env `GOOGLE_SERVICES_FILE_PROD`/`_DEBUG`,
   see `app.config.js`) before building the Android app, so the app can obtain native FCM tokens.
2. Firebase console -> Service accounts -> generate private key JSON -> put on the gateway host and point
   `VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE` at it. Restarting the gateway with it switches from dry-run to real sending.
