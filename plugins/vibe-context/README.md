# vibe-context

myVibeBoard plugin. Supported Paseo versions: see `requirements.paseo` in `paseo-plugin.json`.

```bash
npm install   # first time: creates package-lock.json (commit it)
npm run typecheck && npm test
```

## server/memory (WP-30)

File-backed project memory under `<repo>/.vibe/` (entries carry `id/created/touched/tag` in a
`<!-- vibe:entry ... -->` marker line). Per-file token budget = share of the model context window;
overflow moves the least recently touched entries to `*_ARCHIVE.md` (deterministic, no model).
Only the master actor writes project memory. `memory_entry` is a derived index: files win, rebuild
with `rebuildMemoryIndex`. Entry point: `createMemoryStore` in `server/memory/index.ts`.

## server/inject (WP-31)

`agent.create` hook that injects project context (user directives -> project instructions ->
memory; the task brief follows in the prompt) into agents whose cwd contains `.vibe/`:

| provider       | channel                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| claude         | `systemPrompt` (block prepended once, marker `vibe:context`)                                                   |
| codex          | generated `AGENTS.override.md` (AGENTS.md text + block), git-excluded; verified against a real Codex           |
| kimi, deepseek | marked block in `AGENTS.md`; tracked file: `skip-worktree`, only in a linked worktree; untracked: git-excluded |

Unlisted providers and non-`.vibe` directories are left alone; failures never block agent start.
Task role instructions point at `.vibe/` files and declare them authoritative and read-only. Hook order between plugins is not guaranteed, so the
block is prepended to `systemPrompt` to stay the stable prefix.

## server/compaction (WP-35)

Compacts idle sessions shortly before their prompt cache expires. Time only: a session that is
`idle` (never `waiting` on an approval) and whose `agent_session.cache_expires_at` is less than the
margin away (3 min for a 1 h TTL, 1 min for 5 min) is handled once per idle period. The agent first
writes its progress to `.vibe/sessions/<session id>.md`; then `/compact` is sent (claude, codex) and the
project context block (`server/inject`) is re-injected. CLIs without `/compact` get a handoff: a new
agent cold-starts from the session .md and memory files, the old session ends. A durable
`session.compacted` event is recorded once; the native lifecycle and scheduler share its counter.
Workspace handoffs go through their owner, preserving admission and cancellation rules.

- Expiry is `last turn end + TTL`. TTL per provider comes from the `compaction` plugin settings
  (`ttlSeconds`, e.g. `{"claude": 3600}` for a subscription, `300` for an API key); defaults claude
  3600, codex 300. Statusline-reported TTLs are not read by the daemon yet.
- `detectNativeIdleCompaction` (`native.ts`, replaceable via `CompactionOptions.detectNative`)
  probes the local `claude --help` / `--version` once at start; if Claude Code compacts idle
  sessions itself, claude is skipped. `NATIVE_MIN_VERSION` is null until the release is confirmed.
- A compaction turn that stops on an approval waits up to 10 min for the user, then is retried later.

## server/complexity (WP-83)

Conversation complexity -> context strategy. `classifyComplexity` (pure, `classify.ts`) maps
`{turns, cacheRead, turnPeaks}` to `short` / `multi` / `long`; the scheduler stores the result with
`sessions.setComplexity` after each turn and on every tick. The change event
`session.complexity_changed` comes from the command layer; consumers read it (or the session's
`complexity`), this module writes no extra note.

- **Turns are Paseo agent turns**, not model calls: the scheduler records a window
  (turn_started .. turn_ended) per effective turn, so a turn with 30 model calls is one turn.
  Turns a plugin starts (our compaction/handoff turns while the flow is busy, and turns announced
  with a `system-turns` marker, which is only peeked at, not consumed) are not counted. The
  marker check is best effort: vibe-board's lifecycle consumes the marker and hook order is not
  guaranteed.
- **cacheRead** is summed over vibe-stats' `usage_event` rows of the agent's CLI session ids
  (`CompactionHost.cliSessionIds`: persistence.sessionId / nativeHandle / runtimeInfo.sessionId).
  A turn's **context** is the largest (input + cacheRead + cacheWrite) of the calls inside its
  window. `usage.ts` is read-only and tolerant of a missing table.
- Default rules (settings group `complexity`): short <= 3 turns, multi 4-14, long = 15+ turns, or
  summed cacheRead >= 1,000,000, or >= 25% of turns with peak context >= 177,047 tokens.
- **Persistence** (`state.ts`, `vibe_meta` key `context:complexity:<session id>`): turn windows,
  compaction baseline, early-compaction count, inherited floor; survives daemon restarts. After a
  compaction only turns and usage after it count.
- short: no extra action. multi: (re-)injection after a compaction or in a handoff prompt inlines
  at most `tightMemoryTokens` (1000) of memory, larger files become pointers; the same budget is
  used by the `agent.create` injection for agents in a directory whose session is multi/long
  (`vibe_meta` key `context:tight:<cwd>`, `budgetFor` option). long: additionally compacted at the
  next idle tick even if the cache is not near expiry (`earlyCompactLong`), merged with the TTL
  trigger (one compaction per idle period). Providers without `/compact`, or a session that is long
  again after `handoffAfterCompactions` (2) early compactions, are handed over to a new session.
- A handoff session inherits the complexity (long as multi, since its context is fresh), the
  early-compaction count, and starts counting turns from zero.
- `complexity.enabled=false` turns the whole policy off (TTL behaviour only).

## 第五轮：workspace/task 上下文（WP-112）

新运行使用原生 workspace 和 agent_session 归因，不读取旧卡片作为任务恢复依据。记忆文件及 prompt_override 保留，创建 linked worktree 中的 agent 时按 Git 仓库身份匹配项目覆盖；匹配不唯一不猜项目。默认压缩笔记直接写该会话的 .vibe/sessions/<session id>.md，多个角色不覆盖同一任务笔记。

index.server 实际注册原生生命周期和全角色看门狗；权限等待不会标为卡死。卡死只记状态并给 anchor 一条中文摘要，不绕过调度开启新回合。context 设置保留记忆预算并提供看门狗开关、分钟阈值和按 provider 覆盖。

模型额度/登录/明确模型或 provider 不可用时向 context.continuation_requested 总线发去重请求，并暂停和冻结派发。普通测试/工具错误不轮换。总 agent 及代码复核/验证由各自 owner 执行候选轮换，避免两个插件同时接续同一会话。冷上下文交接同样交回 owner；旧会话停止结果未知时，保留锁和名额。没有支持该事件的任务流程插件时，anchor 摘要明确要求升级，不直接创建新的写入者。

WP-111 消费请求后必须核对 confirmedAt、当前阶段和旧 session，然后确认取消、申请 scheduler.task_resource_request(acquire)、创建同 workspace/worktree 会话、bind、通过 createTaskRuntimeCommands.recordContinuation 原子保存实际模型和候选索引。context.continuation_result 回报真实结果；不能从已改动的实时预设重算确认快照。主代理交接还须带方案、子任务状态和原生会话链接。

通用 createTaskContinuation 控制器覆盖七角色和 master；冷交接保持当前候选，provider 失败才按冻结候选顺序前进，候选耗尽报告。recordContinuation 重放时读取已有替代 session，不再次创建 agent 或复制 usage_event；用量由统计插件按独立原生 CLI session 和日志去重键采集。复杂度状态及记忆派生索引写入统一走 vibe-shared/db/context-state 命令，历史键和值不变。

压缩只对核实空闲且未归档的原生 agent 发起；重启后先刷新状态，不自动恢复已关闭会话。压缩命令超时/权限未解决不会被记作成功。WP-114 已删除旧卡片压缩、卡片事件和子卡交接适配。

压缩的笔记、压缩命令和恢复回合也会走 acquire → bind（当前原生 agent）→ run → idle 后 yield。已有主代理计算名额尚未让出时延后压缩，不占第二份名额，也不释放主代理已有租约。调度回执不明或确认变化时冻结并保留资源；候选失败、冷交接及实际模型记录仍交各自 owner。

WP-114 最终切换后不再读取旧卡片或卡片事件，压缩只依赖原生 agent_session、workspace 与 session.compacted 事件。新任务成员通过宿主群聊压缩入口操作；普通会话保留笔记、压缩和记忆注入。内部压缩消息始终携带 sourceAgentId，保持原生 agent-message 身份。
