# deploy/relay

Isolated deployment of the official [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) on a shared Linux host
(Docker + nginx already present). **Run by hand on the server; the repo never connects anywhere.**

| File                                                        | Purpose                                                                                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.env.example`                                         | Parameter template. Copy to `relay.env` (git-ignored). Only placeholders in git.                                                              |
| `docker-compose.yml`                                        | Own project name/network, unprivileged, resource-limited, port bound to `127.0.0.1` only; builds from the git repo at the pinned `RELAY_REF`. |
| `nginx-site.conf.template` / `nginx-push-location.template` | The single new nginx site (443 TLS, WebSocket proxy, long timeouts, optional `/push/`).                                                       |
| `install.sh` / `uninstall.sh` / `lib.sh`                    | Idempotent install and rollback; both support `--dry-run`.                                                                                    |
| `test-dry-run.sh`                                           | Offline checks (no docker/nginx needed).                                                                                                      |

```bash
bash install.sh --env-file relay.env --dry-run   # print everything, change nothing
bash install.sh --env-file relay.env
bash uninstall.sh --env-file relay.env           # removes only what install.sh added
```

Guarantees: existing nginx files and other sites are never modified; `nginx -t` must pass before reload, otherwise the new
site file is removed; a `nginx -T` summary is saved to `STATE_DIR` first. Full guide (Chinese): `docs/vibe/CONNECTIVITY.md`.

Verified facts (2026-10-19, getpaseo/paseo-relay `main`): no tags/releases, so `RELAY_REF` is a full commit SHA; the image listens on
4000 (`PASEO_RELAY_PORT`); **no required env vars / secrets**; probes `GET /health` (liveness), `GET /ready`; the WebSocket
endpoint is `/ws`. Details: `docs/vibe/CONNECTIVITY.md`.

## Deployment checklist (run by hand on the server, as root)

Copy **both** `deploy/relay/` and `services/vibe-push-gateway/` to the host, keeping their relative layout
(e.g. `/opt/vibe-relay/deploy/relay`, `/opt/vibe-relay/services/vibe-push-gateway`).

1. Pre-checks (read-only)
   - Free loopback ports: `ss -ltn | grep -E ':(<RELAY_PORT>|<PUSH_PORT>)'` must print nothing.
   - server_name free: `nginx -T 2>/dev/null | grep -n '<RELAY_DOMAIN>'` must print nothing.
   - Cert covers the domain: `openssl x509 -in <TLS_CERT> -noout -checkhost <RELAY_DOMAIN>` -> "does match"; key readable.
   - Memory/disk: `free -m` (relay <= 512m, push 128m), `df -h /var/lib/docker /var/lib`.
   - Baseline of other sites, saved to a file: `for h in <SITE_1> <SITE_2> ...; do echo "$h $(curl -sI -o /dev/null -w '%{http_code}' https://$h)"; done | tee /root/sites.before`
2. Execute: `cd deploy/relay && cp relay.env.example relay.env` (fill in), `bash install.sh --env-file relay.env --dry-run`, review, then
   `bash install.sh --env-file relay.env`.
3. Verify
   - `curl -s -o /dev/null -w '%{http_code}
' https://<RELAY_DOMAIN>/health` -> 200; `/ready` -> 200; `https://<RELAY_DOMAIN>/push/healthz` -> `{"ok":true,"dryRun":true}`.
   - `docker compose --project-name vibe-relay ps` shows `relay` and `push` Up; both ports listen on 127.0.0.1 only (`ss -ltn`).
   - Re-run the baseline loop to `/root/sites.after` and `diff /root/sites.before /root/sites.after` must be empty.
   - Point a daemon at the relay and pair (CONNECTIVITY.md section 3.4).
4. Roll back (also on any `diff` output or failed `nginx -t`): `bash uninstall.sh --env-file relay.env` (removes only the marked site file,
   the compose project and our state files), then repeat the baseline diff.
