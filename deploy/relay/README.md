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

Before the first real run verify against the paseo-relay README: the tag/commit for `RELAY_REF`, the container port
(`RELAY_CONTAINER_PORT`, default 4000 is an assumption) and the environment variables to put in `RELAY_APP_ENV_FILE`.
