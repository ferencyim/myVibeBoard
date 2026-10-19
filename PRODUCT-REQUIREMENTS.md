# 产品需求（myVibeBoard）

> 整理稿，产品需求真相源。完整设计见 [docs/vibe/IMPLEMENTATION-PLAN.md](docs/vibe/IMPLEMENTATION-PLAN.md)
> （源自 Claude Docs《自制 Vibe Coding 工具方案（基于 Paseo 二次开发）》）。

## 定位

在 fork 的 Paseo 上自研个人 vibe coding 工作台：电脑上的 daemon 为主服务，统一驱动
Claude Code、Codex、Kimi、DeepSeek 四个 agent；Android 手机可离线编辑看板、远程查看会话并回复提问；
总 agent 负责评估草稿、派发任务和组织验收取证。单用户，客户端为桌面端 + Android。

不在范围内：多人协作、iOS 客户端、OpenCode 及其他 agent、项目预算。

## 已拍板的决定

- 2026-10-19：仓库采用 **GitHub 公开 fork**（ferencyim/myVibeBoard，upstream = getpaseo/paseo）。
  因为是公开仓库，**全局「密钥入库」约定在本仓库不适用**：任何密钥、签名材料、口令都不得提交。
- 自研功能尽量写成仓库内插件（`plugins/vibe-*`）；核心改动（`packages/`）单独提交并加 `[core]` 前缀。
- 每两周合并一次上游 release；保留 Paseo / Tasks（Apache-2.0）与 Switch provider / ccusage（MIT）声明。
- 2026-10-20：总 agent 与草稿规划会话的权限**默认用自动模式**（Claude Code 的 auto 模式；Codex 用对应的自动审阅档），
  用户可在桌面/手机上手动切换权限模式（不再默认使用 bypassPermissions / full-access）。
  自动维护的修复者按所选预设的权限模式，无预设时用「自动接受编辑」类模式。
- 连接：局域网 / Tailscale 直连优先，自建 E2E 中继兜底；中继部署在用户提供的腾讯云主机。

## 模块（详见实施方案）

M1 Agent 接入 · M2 五栏看板（草稿箱/待办/进行中/待验证/已完成）与草稿讨论会话 · M3 验证证据 ·
M4 总 agent · M5 项目记忆与缓存到期前压缩 · M6 资源调度 · M7 总览统计 · M8 Android 端离线同步 ·
M9 连接与中继 · M10 自动维护（maintenance.yml，git 体检、性能慢记录）。

## 推进节奏

- P0 Fork 与基础 → 用户验收 → P1 看板与验证 → P2 总 agent 与上下文 → P3 Android 离线与扩展。
- 2026-10-19：P0 自动化部分完成；用户要求继续推进至全部完成（含 Android 客户端），真机验收合并到最后。

## 环境与资源（2026-10-19 用户提供）

> 仓库公开：主机地址、登录用户等只记在本机 SESSION.md，不入库。

- **Mac 主机**：局域网/Tailscale 上的一台 Mac（SSH 可达），用于跑 iOS 模拟器等需要 macOS 的测试。
  现状：macOS 26.6.2，Xcode 26.6 装在外置盘（需设置 DEVELOPER_DIR，具体路径见 SESSION.md），有 iOS 18.6 / 26.5 模拟器运行时；无 Node / Homebrew。
- **中继服务器**：一台腾讯云主机（SSH 可达，AlmaLinux 8，Docker + nginx）。该机已在跑其它产品
  （多个其它产品的站点与数据库），部署中继必须隔离：独立容器只监听 127.0.0.1，经新增 nginx 站点对外，
  不改动其它站点配置；对外域名已由用户确定（2026-10-20，见 SESSION.md），复用该主机已有的通配证书。
- **硬件取证**：暂不做（P3#6 中固件仿真 / 硬件在环推迟，待用户确定芯片平台）。
- P1 验证证据试点项目（默认，用户未反对）：本仓库自身（Web + 后端）及其 Android App。
