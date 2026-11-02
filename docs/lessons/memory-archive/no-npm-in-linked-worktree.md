# no-npm-in-linked-worktree

> 不要在 node_modules 是 junction 的 worktree 里跑 npm install；oxlint 1.61 在本机每线程提交约 6GB（类型 feedback，最后修改 2026-10-29T22:16:29.073Z）

2026-10-29 两次事故：

1. oxlint 1.61（开 jsPlugins）在本机 Windows 每个线程提交约 6GB 内存，默认 32 线程即 200GB，提交钩子里的 lint 把整机提交内存打满，连带别的会话的测试 PostgreSQL 崩溃。1.65 起已修复（8 线程峰值 0.8GB）。
2. 为升级 oxlint 在 worktree（各 node_modules 是指向主目录的 junction）里跑 `npm install`，npm 删掉了根 junction，又顺着子包 junction 往主目录 packages/\*/node_modules 写入，失败回滚时把主目录 packages/app/node_modules 里约 139 个包清空。

**Why:** junction 让 worktree 的 npm 操作直接作用于主目录共享依赖；回滚会顺着链接删除。

**How to apply:** 依赖变更只在主目录（无 junction 的真实 checkout）里做，且先确认没有其它会话在用；worktree 里只跑 lint/typecheck/测试。跑 lint 等可能吃内存的命令时，若版本未确认安全，用带内存上限的看门狗（scratchpad capped2.ps1 思路）先单文件试。相关：[[heavy-tasks-via-guard]]、[[codex-launch-windows]]
