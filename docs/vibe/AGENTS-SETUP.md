# 四个 Agent 接入指南（P0#4）

目标：Paseo 里只保留 Claude Code、Codex、Kimi、DeepSeek 四个 agent，其余 provider 全部关闭。
**本文不替你登录任何服务，也不含任何凭据。** 所有登录都在终端里由你自己完成。

## 方案：只用用户级配置，不改 packages/ 核心

- 关闭其他 provider：在 `~/.paseo/config.json`（即 `$PASEO_HOME/config.json`）的 `agents.providers` 下写 `enabled: false`。这是 Paseo 的标准机制，对内置 provider 和插件 provider 都有效，无需改核心代码。
- Kimi：Paseo 内置 ACP 目录（`packages/app/src/data/acp-provider-catalog.ts`，id `kimi`，命令 `kimi acp`），在 App 里添加即可，等价于手写 `extends: "acp"`。
- DeepSeek：用仓库内的 `plugins/deepseek-harness/`（来源见该目录 `UPSTREAM.md`），以目录插件方式安装，provider id 为 `deepseek-harness`。
- 本仓库的三个社区插件（`vibe-board`、`switch-provider`、`deepseek-harness`）是独立项目，不是内置插件；是否启用由 `pluginsEnabled` 和 `plugins` 决定。

## 默认存在的 provider 与关闭方式

内置：`claude`、`codex`、`copilot`、`opencode`、`pi`、`omp`（默认已关）。
内置插件 provider：`antigravity`、`muse`、`hoplite`（hoplite 仅在 `agents.providers` 里出现时才参与，不写即不启用）。
ACP 目录里的其他 agent 只有被添加后才会出现。

配置示例（保留四个，关闭其余；Kimi、DeepSeek 见下文）：

```json
{
  "pluginsEnabled": true,
  "agents": {
    "providers": {
      "claude": { "enabled": true },
      "codex": { "enabled": true },
      "copilot": { "enabled": false },
      "opencode": { "enabled": false },
      "pi": { "enabled": false },
      "omp": { "enabled": false },
      "antigravity": { "enabled": false },
      "muse": { "enabled": false }
    }
  }
}
```

改完后执行 `paseo reload`（插件相关变更见下）。注意：你本机现有的 `~/.paseo/config.json` 已经关闭了 copilot、pi、opencode、muse、antigravity，并启用 claude、codex，因此只需补 Kimi 与 DeepSeek；另外已装有 `tasks`、`switch-provider` 等社区插件的旧副本，迁移到本仓库的版本时见文末。**本次没有改动该文件。**

## 1. Claude Code（内置）

1. 安装：`npm install -g @anthropic-ai/claude-code`（或官方安装脚本），确认 `claude --version`，且 `claude` 在守护进程用户的 PATH 中。当前本机 PATH 里没有 `claude`。
2. 登录：在终端运行 `claude`，按提示登录；也可用 `claude setup-token`。登录由你本人完成。
3. Paseo 内启用：不需要额外操作；`agents.providers.claude.enabled` 为 true（默认）。新建 agent 时选 Claude。
4. token 日志：`~/.claude/projects/**/*.jsonl`（Windows：`%USERPROFILE%\.claude\projects`）。

## 2. Codex（内置）

1. 安装：`npm install -g @openai/codex`。本机已在 PATH（`C:\Users\feren\AppData\Roaming\npm\codex`）。
2. 登录：终端运行 `codex login`（或首次运行 `codex` 按提示），由你本人完成。
3. Paseo 内启用：默认启用，新建 agent 选 Codex。
4. token 日志：`~/.codex/sessions/**/rollout-*.jsonl`。

## 3. Kimi Code CLI（内置 ACP 目录）

1. 安装：参考 https://github.com/MoonshotAI/kimi-code ，装好后确认 `kimi --version`，并确认 `kimi acp` 可启动（Paseo 用该命令通信）。本机 PATH 里目前没有 `kimi`。
2. 登录：终端先运行 `kimi` 完成登录（你本人操作）。
3. Paseo 内启用，二选一：
   - App：设置 → Providers → 添加 ACP provider 目录 → 选 Kimi Code CLI。
   - 手写配置（与目录条目等价）：

```json
{
  "agents": {
    "providers": {
      "kimi": {
        "extends": "acp",
        "label": "Kimi Code CLI",
        "command": ["kimi", "acp"]
      }
    }
  }
}
```

`kimi` 不在守护进程 PATH 时，把 `command` 第一项改成绝对路径。4. token 日志：Kimi 的会话数据在 `~/.kimi/` 下（具体子目录以实机为准，先查看 `kimi` 的数据目录）；ccusage 已支持 Kimi 解析。**此路径未在本机核实。**

## 4. DeepSeek（Deepseek Harness 插件）

插件来源：geoqiao/paseo-stuff 的 `plugins/deepseek-harness`（MIT），已引入 `plugins/deepseek-harness/`。它通过 `dsh --profile acp` 启动 DeepSeek Harness。

要求：dsh ≥ 0.1.5-rc.1（版本过低时 provider 显示不可用并给出原因）；守护进程所在机器 Node ≥ 22.19（当前本机 Node 24，满足）；Paseo ≥ 0.11.0。

1. 安装 dsh：按官方仓库 https://github.com/deepseek-ai/deepseek-harness 的说明安装，确认 `dsh --version` 与 `dsh --profile acp --version`，且 `dsh` 在守护进程 PATH 中（否则用 `command` 覆盖，见下）。本机 PATH 里目前没有 `dsh`。
2. 配置密钥：运行 `dsh web`，在 Settings → Models 里填 DeepSeek API key（你本人操作；密钥存放在 `~/.dsh/.credentials.yaml`，不要提交进任何仓库）。
3. 安装插件（需先同意启用插件：`pluginsEnabled: true`）：

```bash
cd plugins/deepseek-harness && npm ci --ignore-scripts --legacy-peer-deps
paseo plugin install D:\devRepo\myVibeBoard\plugins\deepseek-harness
paseo plugin ls
paseo reload
```

插件在 `paseo-plugin.json` 的 `build` 里声明了 `npm ci` 与 `npm run check`。装好后在新建 agent 的 provider 列表里应出现 DeepSeek Harness（id `deepseek-harness`）。4. dsh 不在 PATH 时覆盖命令（数组整体替换默认命令，务必保留 ACP 的 `--profile`）：

```json
{
  "agents": {
    "providers": {
      "deepseek-harness": {
        "command": ["C:\path\to\dsh.cmd", "--profile", "acp"]
      }
    }
  }
}
```

5. token 日志位置：
   - dsh 的会话以未压缩 JSONL 保存在 `$DSH_HOME/sessions/`，`DSH_HOME` 默认 `~/.dsh`，即 `%USERPROFILE%\.dsh\sessions\`（出自 dsh 官方文档对 SDK profile 的描述；acp profile 是否沿用同一目录，需装好 dsh 后实机核实）。
   - 官方 dsh 不提供原始 token 增量事件（插件文档说明）。余额可在 Paseo 的 Usage 面板看到：插件按 dsh 的方式读取 `DEEPSEEK_API_KEY`（环境变量 → `$DSH_HOME/.credentials.yaml` → `$DSH_HOME/.env`），只发往 `https://api.deepseek.com/user/balance`。
   - 注意 dsh 默认会向 DeepSeek 随请求上传会话日志的一部分（`session-log-deepseek`，SDK profile 文档），如不希望可在其 profile 里按官方文档关闭；另可设 `DSH_TELEMETRY_MODE=DISABLED` 关闭遥测。
6. 已知限制（来自插件文档）：dsh 不回放历史，daemon 重启或 agent reload 后上下文还在，但时间线显示为空；不支持 provider 斜杠命令、steering、plan；Paseo 的额外系统提示不会传给 dsh；Windows 与手机客户端未经作者测试。

## 验证清单

1. `paseo provider ls`（或 App 的 provider 列表）只出现 Claude、Codex、Kimi、DeepSeek Harness 四项。
2. 每个 agent 各开一个会话发一句话，确认可回复；再用手机端从同一守护进程发起一次。
3. 缺少的 CLI 在 provider 列表里会显示不可用及原因，按原因补装即可。

## 迁移你本机已有的旧插件副本

`~/.paseo/config.json` 里已有 `tasks`（`~/.paseo/local-plugins/tasks`）与 `switch-provider`（`~/.paseo/plugins/...`）。改用本仓库版本时，需要先 `paseo plugin remove <id>`，再 `paseo plugin install <本仓库插件目录> --id <id>`；二者不能同时以同一 id 存在。需要这样做时请先确认，本次未改动。
