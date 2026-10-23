# vibe-stats

第五轮任务用量统计。通过命令中心“统计：打开用量概览”按需打开，统计设置放在同一屏幕，不注册常驻侧栏或独立设置页。

- 增量扫描 CLI 日志，原生 provider session ID 与 agent_session 的 workspace、角色关联，再查询原生项目；所有数据库写入使用 vibe-shared 的 createUsageCommands。
- 按项目、workspace、七角色（以及总 agent）、模型和本地日期展示 token / 估算费用；历史记录保留原项目/模型/日期，不创建伪 task，也不依赖 card 表。
- 唯一 dedupe_key 保持事件身份；接续新会话、镜像旧日志、索引重启和全量重放不重复计数。provider session ID 按提供方隔离，冲突归属不猜测。
- 日志实际模型决定模型归因，接续不把历史用量改成新模型。未知价格只展示 token 和“价格未知”；可在屏幕内指定 LiteLLM 价格 JSON，刷新补齐旧记录价格。
- 保留输出速度、压缩次数、会话时长/等待回复与资源采样。采样由调度器写入；统计只读。

默认日志位置：Claude 的 ~/.config/claude/projects 与 ~/.claude/projects，Codex 的 ~/.codex/sessions，Kimi 的 ~/.kimi/sessions，DeepSeek 的 ~/.dsh/sessions。可在本页覆盖目录；Kimi / DeepSeek 解析器仍未在真实安装上验证。

验证：在插件目录运行 npm test 与 npm run typecheck。真实 ccusage 对账通过 VIBE_E2E_CCUSAGE=1 npm test -- reconcile 显式启用，默认跳过，不作为常规验收。
