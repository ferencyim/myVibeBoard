# Spike：`file:` 依赖能否替代 vibe-shared 副本

> WP-00 产出。日期 2026-10-19，基于 paseo 0.12.0。复现命令：`node --import tsx scripts/vibe/spike-shared-file-dep.mjs`

## 问题

插件编译器（`packages/server/src/server/plugins/compiler.ts`）禁止 import 插件目录外的源码。`plugins/vibe-shared` 能否改成各插件的 `file:` 依赖（`"@vibe/shared": "file:../vibe-shared"`），从而不再需要复制？

## 方法

脚本在临时目录建夹具：`plugins/vibe-shared`（`@vibe/shared`，TS 源码包）与 `plugins/vibe-demo`（`file:../vibe-shared`）。在 `vibe-demo` 里跑**真实的 `npm install`**（生成 `node_modules/@vibe/shared` 链接），再用 daemon 自带的 `compilePlugin` 编译 client 与 server 两个 bundle。

## 结果

- `npm install` 退出码 0；`package-lock.json` 记录 `{"resolved": "../vibe-shared", "link": true}`（Windows 上为目录联接）。
- `compilePlugin` 成功；server 与 client bundle 都内联了 `@vibe/shared` 的代码。原因：`findDependencyRoot` 对「包名匹配 specifier、且位于插件目录之外并互不包含」的解析结果放行（`linkedDependencyRoots`）。
- 目录安装（`paseo plugin install <dir>`）是原地引用、不复制，所以相对链接在本机场景不会失效。

## 结论

**技术上可行，但不采用；默认仍按复制方案（`scripts/vibe/sync-shared.mjs`）推进。** 理由：

1. App 侧（`packages/app/src/vibe/generated/`）走 Metro/Expo，不经过插件编译器，仍需要一份副本；复制机制无论如何都要存在，再叠加 `file:` 只会变成两套机制。
2. `file:` 方案要求 `plugins/vibe-shared` 自己有 `package.json` 与依赖安装（它 import 的 `zod` 等从 vibe-shared 目录解析），每个插件的 `npm ci` 还依赖兄弟目录存在；副本方案下插件目录自包含，`cd plugins/<p> && npm ci && npm run typecheck && npm test` 不依赖其他目录。（此条为推断，未实测。）
3. 若日后只剩插件消费者、App 不再需要副本，可以按本 spike 的方法改为 `file:`：在各插件 `package.json` 加依赖、删除 `vibe.shared` 声明与 `shared/vibe`、`server/vibe` 副本目录即可。

未验证项：安装到非本机目录（git/npm 源）时相对链接是否可用——本项目只用目录安装，不在范围内。
