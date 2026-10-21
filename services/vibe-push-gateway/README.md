# vibe-push-gateway

Tiny Node service (no dependencies) between the Paseo daemon and FCM HTTP v1 / vivo push.
Deployed on the same host as the relay behind its own reverse-proxy location (e.g. `/push/`); see WP-48.

## API

`POST /v1/push` with `Authorization: Bearer <VIBE_PUSH_AUTH_TOKEN>` and JSON `{token,title,body,data,channel?}`.
`channel` is `"fcm"` (default when absent, so old daemons keep working) or `"vivo"` (`token` is then the vivo regId).
Responses: 200, 400 bad body or channel, 401 bad auth, 404 token unregistered (daemon then drops the token),
502 provider failure, 503 the requested channel has no credentials on this gateway.
`GET /healthz` reports `{ok,dryRun,channels:{fcm,vivo}}`.

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
| `VIVO_APP_ID`, `VIVO_APP_KEY`, `VIVO_APP_SECRET` | vivo open platform credentials. All three are needed; if any is missing the vivo channel is off (FCM is unaffected). |
| `VIVO_PUSH_MODE` | `1` = test push (only reaches test devices registered in the vivo console; the only mode an unpublished app may use), `0` = production (default). |
| `VIBE_PUSH_VIVO_ENDPOINT` | Override the vivo API base URL (tests). |
| `HOST` (127.0.0.1), `PORT` (8787) | Listen address. |

Dry-run (no FCM account and no vivo credentials, or the flag) logs the message that would be sent for either channel
(token/regId truncated) and sends nothing. If only one channel is configured, requests for the other get 503.

## vivo channel

`src/vivo.mjs` follows the vivo push server API (https://api-push.vivo.com.cn): `POST /message/auth` with
`{appId, appKey, timestamp(ms), sign}` where `sign = md5(appId + appKey + timestamp + appSecret)` (lowercase hex) returns an
`authToken` (valid 24 h; cached and refreshed after one hour, and once more on result `10000`); `POST /message/send`
with the `authToken` header sends a single notification to a `regId` with a unique `requestId` (<= 64 chars), `pushMode`,
title <= 40 and content <= 100 characters. The event data goes in `clientCustomMap` and the notification uses `skipType` 3
(click handled by the app), so a tap routes like an FCM data message. Result `10302` (regId invalid/expired) is reported as
404 so the daemon drops the token; other non-zero results are 502 with the vivo code in `status`.
Sources: official docs https://dev.vivo.com.cn/documentCenter/doc/362 (page is script-rendered, so field details were
cross-checked against the public SDK docs at https://pkg.go.dev/github.com/modood/pushapi/vivopush and the error-code table
at https://help.aliyun.com/en/document_detail/398576.html). Not yet exercised against the real service.

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
3. vivo (only for vivo phones): vivo open platform -> create the app, enable push -> AppID/AppKey/AppSecret into the gateway env
   file on the server (`VIVO_APP_ID`, `VIVO_APP_KEY`, `VIVO_APP_SECRET`, `VIVO_PUSH_MODE`); the vivo client SDK aar and
   AppID/AppKey for the app build go under `.secrets/vivo/` (see `docs/vibe/USER-GUIDE.md`, section 11).
