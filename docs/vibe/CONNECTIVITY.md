# 连接与中继（myVibeBoard）

本文说明手机 App 如何连上电脑上的 daemon：配对、选路、自建中继的部署与回滚、安全边界。
本仓库是公开的，文中一律用占位符（`<RELAY_DOMAIN>`、`<DAEMON_HOST>` 等），真实域名、IP、证书路径只放在你本机的 `deploy/relay/relay.env`（已 gitignore）。

## 1. 配对（沿用 Paseo，不做改动）

- daemon 首次启动会生成自己的密钥对（E2EE 握手用，公钥在配对二维码里）。
- 在桌面 App 的 **Settings → 你的主机 → Pair a device**，或 CLI 运行 `paseo daemon pair`，会得到二维码/配对链接；手机 App 扫码（或粘贴链接）即完成配对。
- 配对信息里包含中继地址、daemon 公钥和会话标识；手机与 daemon 之间的流量由这对密钥端到端加密，中继只做转发。
- **配对二维码/链接等同密码**：拿到它的人可以连上你的 daemon。不要截图外发、不要贴进聊天或仓库；怀疑泄露时重新配对（见第 4 节）。

## 2. 选路：一个主机，多条 connection

App 里一个 host 可以挂多条 connection，运行时周期探测并自动选最优（上游 `host-runtime` 已实现）。我们**不做 mDNS 自动发现**，额外线路由你手动添加：

| 线路      | 适用                           | 设置                                                                                            |
| --------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| 局域网    | 手机与电脑同一 Wi-Fi，延迟最低 | Settings → Add host → Direct connection，填 `<DAEMON_LAN_IP>`:6767；daemon 需监听该网卡（见下） |
| Tailscale | 在外网，不想暴露任何端口       | 两端装 Tailscale，填 `<DAEMON_TAILSCALE_IP>`:6767                                               |
| 中继      | 兜底，无需任何网络配置         | 配对时自动加入（本文第 3 节为自建中继）                                                         |

直连要让 daemon 监听非回环地址（`daemon.listen` 设为 `<DAEMON_LAN_IP>:6767` 之类，或环境变量 `PASEO_LISTEN`）。**这类配置现在必须同时设置 daemon 密码**，否则 daemon 拒绝启动：

- 密码：环境变量 `PASEO_PASSWORD`，或在配置里设置 `daemon.auth.password`（bcrypt 哈希，见上游 Password authentication 文档）；手机 App 添加直连时在 **Daemon password** 里填同一个密码。
- 只绑回环（`127.0.0.1`/`::1`/`localhost`）、unix socket 或命名管道时不要求密码。
- 明知风险、确实要无密码监听（例如仅在隔离测试环境）时，设置 `PASEO_ALLOW_INSECURE_LISTEN=1` 显式放行。
- 这一强制是我们对核心的小改动（`bootstrap.ts` 的 `assertDirectListenAuth`），中继线路不受影响（daemon 向外连中继，本身仍可只绑回环）。

## 3. 自建中继（部署到共用 Linux 服务器）

官方中继是 [getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay)（Elixir）。我们不改它，只把它按固定版本构建成一个**独立 docker 容器**，前面挂一个**新增的** nginx 站点。目标主机是已有 Docker 和 nginx 的共用生产机：脚本只新增自己的东西，绝不修改任何现有 nginx 配置或其他站点。

### 3.1 前置条件

1. 域名 `<RELAY_DOMAIN>` 的 DNS 已指向服务器。
2. 服务器上已有该域名的 TLS 证书（fullchain 与私钥路径）。签发方式随你（acme.sh、certbot 等），脚本只接收路径，不负责签发。
3. 安全组/防火墙放行 443（已有站点通常已放行）。中继容器只绑 `127.0.0.1`，不需要对外开别的端口。
4. 已核实的中继事实（2026-10-19，[getpaseo/paseo-relay](https://github.com/getpaseo/paseo-relay) `main`，见其 [README](https://github.com/getpaseo/paseo-relay/blob/main/README.md)、[Dockerfile](https://github.com/getpaseo/paseo-relay/blob/main/Dockerfile)、[config/runtime.exs](https://github.com/getpaseo/paseo-relay/blob/main/config/runtime.exs)）：
   - 仓库**没有任何 tag / release**，`RELAY_REF` 必须用完整 commit SHA（2026-08-22 的 main 为 `3fc41c96c8c63f3a7109e832899cc57d473c4531`，部署前再核一次）。
   - 容器内监听 4000（镜像设置 `PASEO_RELAY_HOST=0.0.0.0`、`PASEO_RELAY_PORT=4000`），WebSocket 路径 `/ws`，健康检查 `GET /health`（存活）、`GET /ready`（就绪）、`GET /metrics`。
   - **没有必需的环境变量或密钥**（不需要 `SECRET_KEY_BASE`；它不是 Phoenix 应用）。可选项均为 `PASEO_RELAY_*`，建议设 `PASEO_RELAY_MEMORY_WATERMARK_BYTES`（本部署由 `RELAY_MEMORY_WATERMARK_BYTES` 传入，约为内存上限的 70%），否则内存吃紧时是被 OOM 杀掉而不是主动限流。
   - 单节点不需要 `RELEASE_COOKIE` / 集群配置。

### 3.2 部署步骤（在服务器上手动执行，root）

```bash
cd deploy/relay
cp relay.env.example relay.env     # 填 RELAY_DOMAIN / RELAY_PORT / RELAY_REF / TLS_CERT / TLS_KEY 等
bash install.sh --env-file relay.env --dry-run   # 先看：将执行的命令与将写入的文件全部打印，不改任何东西
bash install.sh --env-file relay.env             # 确认无误后执行
```

脚本做的事（按顺序，任何一步失败都会撤销本次新增的站点文件，必要时 `compose down`）：

1. 预检：root、docker compose、nginx 存在；证书与私钥可读且证书覆盖 `<RELAY_DOMAIN>`（只读检查，复用已有通配证书即可，脚本不签发、不拷贝、不修改证书）；`NGINX_SITE_NAME` 目标文件若已存在但不是本脚本创建的则拒绝；`<RELAY_DOMAIN>` 若已出现在别的站点的 `server_name` 则拒绝；`127.0.0.1:<RELAY_PORT>` 被占用则拒绝。
2. 把 `nginx -T` 的摘要（配置文件列表、server_name、listen）备份到 `STATE_DIR`。
3. 若设置了 `PUSH_PORT`：生成随机 `VIBE_PUSH_AUTH_TOKEN` 写入 `PUSH_ENV_FILE`（权限 600，不打印）。
4. `docker compose up -d --build`（中继；设置了 `PUSH_PORT` 时同一项目内再带上推送网关服务）：独立项目名/网络、无特权、`cap_drop: ALL`、`no-new-privileges`、内存/CPU/进程数限制、`restart: unless-stopped`，端口只绑 `127.0.0.1:<RELAY_PORT>`。
5. 渲染并写入**唯一一个**新 nginx 站点文件（`server_name <RELAY_DOMAIN>`，443 TLS，WebSocket 反代，读写超时 3600s）。
6. `nginx -t` 通过才 `nginx -s reload`；不通过则删除新文件、不 reload。
7. 写 manifest，做一次本机冒烟请求。

### 3.3 推送网关（WP-44，可选）

网关是 `services/vibe-push-gateway`（Node，无依赖）。设置 `PUSH_PORT`（如 18787，须与 `RELAY_PORT` 不同、主机上未占用；网关自带默认 8787 常被占用）后，`docker-compose.yml` 里的 `push` 服务（profile `push`，由脚本自动启用）与中继在同一 compose 项目中独立运行：只绑 `127.0.0.1:<PUSH_PORT>`，只读根文件系统、`cap_drop: ALL`、128m 内存上限。`VIBE_PUSH_AUTH_TOKEN` 由 install.sh 随机生成并写入 `PUSH_ENV_FILE`（600，需要时在服务器上读取，别贴进聊天）。没有 FCM 服务账号时网关为 dry-run（`/push/healthz` 返回 `dryRun:true`）；之后要真发送，把服务账号 JSON 放到服务器并给 `push` 服务挂载、设置 `VIBE_PUSH_FCM_SERVICE_ACCOUNT_FILE`（不入库）。vivo 手机用 vivo 通道：在同一个 `PUSH_ENV_FILE` 里追加 `VIVO_APP_ID` / `VIVO_APP_KEY` / `VIVO_APP_SECRET` / `VIVO_PUSH_MODE`（1 测试推送、0 正式，默认 0），重启 `push` 服务；三个凭据缺任何一个则 vivo 通道关闭，FCM 不受影响，两个通道各自独立，请求里带 `channel` 字段路由。部署时需把 `deploy/relay/` 和 `services/vibe-push-gateway/` 一起拷到服务器（保持相对位置）。

设置 `PUSH_PORT` 后，同一站点多一个 `location /push/`，前缀被去掉后转发到网关，即 `https://<RELAY_DOMAIN>/push/v1/push`；`PUSH_PORT` 留空则不启动网关、不生成该 location。daemon 侧：配置 `daemon.push.gateway=https://<RELAY_DOMAIN>/push`，并设置环境变量 `PASEO_PUSH_GATEWAY_TOKEN`（与 `PUSH_ENV_FILE` 里的 token 相同）。

脚本可重复执行（幂等）：站点文件内容变化才替换，旧版本备份在 `STATE_DIR`，容器由 compose 对账。

### 3.4 daemon 与手机侧（relay 配置位置与配对携带方式）

daemon 的中继配置（`packages/server/src/server/config.ts` 的 `resolveRelayConfig`，优先级：CLI 参数 > 环境变量 > `~/.paseo/config.json` > 默认）：

| 项                         | 环境变量                      | config.json                   | 默认                                                           |
| -------------------------- | ----------------------------- | ----------------------------- | -------------------------------------------------------------- |
| 启用                       | `PASEO_RELAY_ENABLED`         | `daemon.relay.enabled`        | false（新 home）                                               |
| daemon 出站连接地址        | `PASEO_RELAY_ENDPOINT`        | `daemon.relay.endpoint`       | `relay.paseo.sh:443`                                           |
| 是否 TLS                   | `PASEO_RELAY_USE_TLS`         | `daemon.relay.useTls`         | 仅官方地址默认 true，**自定义地址默认 false，必须显式设 true** |
| 写进二维码的地址（可不同） | `PASEO_RELAY_PUBLIC_ENDPOINT` | `daemon.relay.publicEndpoint` | 同 endpoint                                                    |
| 二维码里的 TLS             | `PASEO_RELAY_PUBLIC_USE_TLS`  | `daemon.relay.publicUseTls`   | 同 useTls                                                      |
| 二维码落地页               | `PASEO_APP_BASE_URL`          | `app.baseUrl`                 | `https://app.paseo.sh`                                         |

daemon 以 `role=server`、`serverId`、`v=2` 经 `wss://<RELAY_DOMAIN>:443/ws` 出站连接中继。**配对二维码**内容是 `<appBaseUrl>/#offer=<base64url(JSON)>`，JSON 为 `{v:2, serverId, daemonPublicKeyB64, relay:{endpoint, useTls}}`（`connection-offer.ts` / `pairing-offer.ts`），即中继地址随二维码一起发给手机；App 内没有写死的中继地址，只用二维码里的值（`relay.paseo.sh` 只是 daemon 侧默认）。

所以自建中继只需在 daemon 一侧（`~/.paseo/config.json`）：

```json
{ "daemon": { "relay": { "enabled": true, "endpoint": "<RELAY_DOMAIN>:443", "useTls": true } } }
```

重启 daemon 后重新配对（第 1 节），手机扫新的二维码即走自建中继。

### 3.5 回滚

```bash
bash uninstall.sh --env-file relay.env --dry-run
bash uninstall.sh --env-file relay.env
```

只移除本脚本创建的东西：带 `managed-by: vibe-relay` 标记的站点文件（删除后先 `nginx -t`，失败则恢复文件且不 reload）、compose 项目（容器、网络、本地构建的镜像）、manifest 与备份摘要；应用环境文件仅在为空时删除，有内容则保留并提示。任何现有 nginx 文件都不会被碰。

### 3.6 本地验证（不连服务器）

```bash
bash deploy/relay/test-dry-run.sh
```

离线断言：dry-run 输出、站点模板渲染、`nginx -t` 在 reload 之前、占位符被拒、仓库内无非回环 IP；本机装有 shellcheck / docker 时会额外跑 shellcheck 与 `docker compose config`，否则跳过。

## 4. 安全说明

- **中继能看到什么**：连接的 IP、时间、消息大小和会话 ID；看不到消息内容（端到端加密）。我们的 nginx 站点默认 `access_log off`，不额外留访问日志。
- **配对二维码等同密码**：见第 1 节。轮换方法：在 daemon 上重新生成配对信息并在手机上移除旧 host、重新扫码。
- **直连必须设密码**：监听非回环地址而无密码，同网段任何人都能连上 daemon、进而让 agent 执行命令，因此核心现在直接拒绝启动（第 2 节）。
- **Tailscale 优先于开放端口**：不要为了直连把 daemon 端口映射到公网。
- **服务器侧**：中继容器无特权、只绑回环；应用环境文件（密钥）权限 600，不入库；证书私钥路径只写在本机 `relay.env`。
- **公开仓库纪律**：真实域名、IP、证书路径、密码只存在于 `relay.env`、服务器与你的密码管理器；仓库只有 `<RELAY_DOMAIN>` 这类占位符。
