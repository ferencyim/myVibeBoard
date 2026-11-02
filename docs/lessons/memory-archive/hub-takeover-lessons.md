# hub-takeover-lessons

> 打开资源中枢接管前，先用真实锁目录形态测；日用 daemon 设了 VIBE_HOME；guard 的 slots 是机器总名额（类型 project，最后修改 2026-10-30T13:06:31.822Z）

2026-10-30 两次打开中枢「接管全机重任务」都出了问题，第二次让别的会话的数据库任务排队约 10 分钟：

1. 日用 daemon 设了 VIBE_HOME，被中枢当成开发 daemon，hub.json 写进私有目录（已在 install-local.ps1 设 VIBE_HUB_DIR / VIBE_HUB_ADMISSION_FILE）。
2. /v1/status 在请求路径里采样指标超过 2 秒，guard 静默回退本地（已改 /v1/ping + 后台采样 + FALLBACK 提示）。
3. guard 的 `slots` 是机器总名额（slots.txt），却被当成单个 job 的占用发给中枢，空闲时也 slots_full（WP-180 修）。

另：同日我把 ci-dashboard 里 win-heavy-guard.admission.json 的未提交改动（硬上限 5、最低可用 5GB、CPU 90%）误判为中枢写坏，想恢复；实际是用户自己改的。用户要求阈值少留裕度、由总协调 bot 判断平衡值（WP-181）。见到阈值文件与仓库不一致时，先问，不要当成事故去恢复。

**Why:** 测试只用了 slots=1 的干净临时目录，没复刻真实锁目录（slots.txt、admission-state.json）；接管影响全机所有会话。

**How to apply:** 再开接管前：回归测试必须用真实锁目录形态；先通知其它会话并避开它们的发布窗口；开启后立刻用两个轻量命令验证 admission_path=hub 且能放行；异常时先放 hub.disabled，再停 daemon 并把 vibe_meta 的 hub.takeover 设为 false。应急手段写在 [[heavy-tasks-via-guard]] 相关文档里。
