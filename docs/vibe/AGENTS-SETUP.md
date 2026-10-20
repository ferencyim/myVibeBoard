# Agent 接入指南（P0#4）

目标：按你的需要启用 Paseo 支持的 provider。Claude Code、Codex、Kimi、DeepSeek 只是本文的**示例**，不是必须、也不是仅有的四个：
Paseo 支持的任何 provider（内置、ACP 目录里的、插件提供的）启用后，看板、总 agent、调度器都会自动把它当作可选 agent，不需要改代码。
**本文不替你登录任何服务，也不含任何凭据。** 所有登录都在终端里由你自己完成。

## 方案：只用用户级配置，不改 packages/ 核心

- 启用/关闭任意 provider：在 `~/.paseo/config.json`（即 `$PASEO_HOME/config.json`）的 `agents.providers` 下写 `enabled: false`。这是 Paseo 的标准机制，`enabled: true` 启用、`false` 关闭，对内置 provider 和插件 provider 都有效，无需改核心代码。不想用的可以关，想用的随时开。
- Kimi：Paseo 内置 ACP 目录（`packages/app/src/data/acp-provider-catalog.ts`，id `kimi`，命令 `kimi acp`），在 App 里添加即可，等价于手写 `extends: "acp"`。
- DeepSeek：用仓库内的 `plugins/deepseek-harness/`（来源见该目录 `UPSTREAM.md`），以目录插件方式安装，provider id 为 `deepseek-harness`。
- 本仓库的三个社区插件（`vibe-board`、`switch-provider`、`deepseek-harness`）是独立项目，不是内置插件；是否启用由 `pluginsEnabled` 和 `plugins` 决定。

## 默认存在的 provider 与关闭方式

内置：`claude`、`codex`、`copilot`、`opencode`、`pi`、`omp`（默认已关）。
内置插件 provider：`antigravity`、`muse`、`hoplite`（hoplite 仅在 `agents.providers` 里出现时才参与，不写即不启用）。
ACP 目录里的其他 agent 只有被添加后才会出现。

配置示例（示例：启用 claude、codex，关闭其余；Kimi、DeepSeek 见下文，其他 provider 照此增删即可）：

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

## 启用其他任意 provider

1. 内置 provider（如 `copilot`、`opencode`、`pi`）：在 `agents.providers.<id>` 写 `enabled: true`，并按其 CLI 要求安装、登录。
2. ACP 目录里的 agent：App 设置 → Providers → 添加 ACP provider 目录，选中即可（等价于手写 `extends: "acp"` 与 `command`）。
3. 插件 provider：`paseo plugin install <插件目录>`，装好后在 provider 列表里出现，必要时同样用 `enabled` 控制。
4. 看板侧无需额外配置：预设（preset）里选这个 provider 即可；总 agent 的推荐、调度器的并发上限与额度闸门都以 provider id 为键，自动覆盖新 provider。
   - 调度器的能力表（`vibe-scheduler` 设置 `agentProfiles`）为每个 provider 自动生成一条中性默认档（tier 2、无擅长标签）；想让它更偏好/更回避某个 agent，
     在 `agentProfiles` 里加同 id 的条目覆盖 tier、擅长标签（`strengths`）和支持的平台（`platforms`）。
   - 每 provider 并发上限用 `providerLimits`，如 `opencode=1`。
   - 总 agent 自己的 provider/模型由其订阅设置选择；总 agent 的权限模式 `auto` 对未知 provider 会去找名为 `auto` 的模式，找不到就用该 provider 的默认模式，不会报错。
5. 用量统计（`vibe-stats`）内置解析器只覆盖 Claude Code、Codex、Kimi、DeepSeek 的本地日志；其他 CLI 的会话仍可正常使用，只是不进入 token 统计（不会报错）。
   需要统计时新增解析器：在 `plugins/vibe-stats/server/parsers.ts` 实现 `Parser`（`provider` 与 `parseLine`，返回统一的用量记录）并登记到 `PARSERS`，
   在 `paths.ts` 里补日志目录与文件匹配规则，在 `shared/rpc.ts` 的 `PROVIDERS` 加上 id，再给模型补价格（`pricing.ts` 或 `pricingFile`）。

## 验证清单

1. `paseo provider ls`（或 App 的 provider 列表）出现你启用的 provider（示例配置下为 Claude、Codex、Kimi、DeepSeek Harness），没有你不想要的。
2. 每个 agent 各开一个会话发一句话，确认可回复；再用手机端从同一守护进程发起一次。
3. 缺少的 CLI 在 provider 列表里会显示不可用及原因，按原因补装即可。

## 迁移你本机已有的旧插件副本

`~/.paseo/config.json` 里已有 `tasks`（`~/.paseo/local-plugins/tasks`）与 `switch-provider`（`~/.paseo/plugins/...`）。改用本仓库版本时，需要先 `paseo plugin remove <id>`，再 `paseo plugin install <本仓库插件目录> --id <id>`；二者不能同时以同一 id 存在。需要这样做时请先确认，本次未改动。
