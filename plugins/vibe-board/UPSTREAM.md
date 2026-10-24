# Upstream

> WP-114：保留上游来源和改造历史用于许可证追溯。当前插件提供原生任务流程；下列卡片、看板、旧 MCP/CLI 和 LWW 路径均已退役，不是当前接口文档。

- Source: https://github.com/anh-chu/paseo-plugin-tasks
- Commit: 147b5ea33d2dfed0c53beae4fdaae79f36d817fa
- Published as: npm paseo-plugin-tasks@0.1.1 (Paseo registry id anh-chu/tasks)
- License: Apache-2.0 (see LICENSE in this directory; no NOTICE file upstream)
- Imported: 2026-10-19
- Role in myVibeBoard: historical base of vibe-board; rewritten for native task conversations in round 5.

## Local changes versus upstream

- Added `@getpaseo/client@0.11.2` to devDependencies (upstream typecheck fails without it) and updated package-lock.json.
- Added a local `vitest.config.ts` so tests do not pick up the repo-root vitest config.
- Removed `.git`/`.github`. Excluded from root tsconfig/oxlint/oxfmt/knip (standalone project with its own node_modules).

## WP-10 server rework (plugin id `tasks` -> `vibe-board`)

- Manifest: id `vibe-board`, `requirements.paseo` `>=0.12.0 <0.13.0`; package `@vibe/board` (private); `vibe.shared` consumer declaration; `@getpaseo/*` bumped to 0.12.0.
- Removed upstream server code: `server/{store,domain,schema,sqlite,types,bridge,cli-runner,attachments}.ts`, the 45 `tasks.*` RPCs on the server side, folders, subtask/label/comment/thread/delegate/due-date model, the private `tasks.db` (old data is not migrated: new database, new structure) and `test/tasks.test.ts`.
- New server: `server/service.ts` (board service over `createVibeStore` from vibe-shared and the shared `vibe.db`), `server/rpc.ts`, `server/attachments.ts` (blobs in the `attachment` table), `server/mcp/{bridge,tools,instructions}.ts` (tools `vibe_*`, loopback bridge), `server/cli/runner.ts`, `bin/vibe-board.mjs`. New RPC contract in `shared/rpc/` (`vibe.*`).
- Kept as-is until WP-11 replaces the UI: `client/**`, `index.client.tsx`, `shared/{contract,constants,directive}.ts` (legacy Tasks contract the old UI still imports; no server handles it any more). `shared/settings.ts` now exports `boardSettings` (`tasksSettings` is a compatibility alias).
