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
- 连接：局域网 / Tailscale 直连优先，自建 E2E 中继兜底；中继服务器待用户准备好后再部署（P0 先跳过）。

## 模块（详见实施方案）
M1 Agent 接入 · M2 五栏看板（草稿箱/待办/进行中/待验证/已完成）与草稿讨论会话 · M3 验证证据 ·
M4 总 agent · M5 项目记忆与缓存到期前压缩 · M6 资源调度 · M7 总览统计 · M8 Android 端离线同步 ·
M9 连接与中继 · M10 自动维护（maintenance.yml，git 体检、性能慢记录）。

## 推进节奏
- P0 Fork 与基础 → 用户验收 → P1 看板与验证 → P2 总 agent 与上下文 → P3 Android 离线与扩展。
- 当前：P0 进行中（2026-10-19 起）。

## 待用户确认（P1/P3 前）
- 硬件项目常用芯片平台与开发板（ESP32 / STM32 / nRF …）。
- 是否有 Mac 主机（iOS 模拟器取证）。
- P1 验证证据的 1–2 个试点项目。
