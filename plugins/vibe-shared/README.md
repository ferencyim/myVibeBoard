# Vibe 共享层

此目录是插件业务合同、数据库迁移和命令的唯一源，由 `npm run vibe:sync-shared` 复制到各插件；生成副本不可手改。

新流程以原生 workspace / task conversation 为入口，业务层保留 task、artifact、成员配置、证据、调度租约、维护规则、记忆和统计。聊天永久历史由宿主保存。设置命令保留项目扩展、预设候选顺序、七角色默认和提示词覆盖。所有业务写入通过共享命令层事务。

WP-114 的 core v14 在升级写入前通过 `backupVibeDb` 一致性备份并只读检查；备份失败即停止。删除旧表前先完成其它 owner 的归属升级；verify v4 与 core v14 的删除同事务，失败回滚。旧卡、旧卡会话与旧卡证据仅在备份中保留，不生成 task。新 task、artifact、原生成员与新证据原样保留。历史统计和维护计数保留原始标识；旧手机同步表及写入合同已移除。

运行 `npm run typecheck`、`npm test` 与根目录的 `npm run vibe:sync-shared:check` 验证。
