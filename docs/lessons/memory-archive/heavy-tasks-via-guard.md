# heavy-tasks-via-guard

> 本机桌面/APK 构建等重任务必须经 win-heavy-guard 排队执行（类型 feedback，最后修改 2026-10-29T11:19:28.051Z）

桌面构建（build:server + web + electron-builder）、APK 构建、大批量测试等重任务，一律经
`bash D:/devRepo/ci-dashboard/queue/win-heavy-guard.sh run --owner MYVIBE:<名称> --priority 2 --mem-gb 4 -- bash -lc "<命令>"` 执行，后台运行；`status` 子命令看队列。

**Why:** 全局约定要求重任务按实时资源动态排队（本机常有多个会话的全量门、模拟器同时在跑，CPU 常在 80%+）。2026-10-29 我曾直接跑桌面构建没走队列，事后补正。

**How to apply:** 单个测试文件不用排队；构建、打包、全量套件、模拟器都要排。排队可能等很久，期间做别的工作。相关：[[real-ui-acceptance]]、[[codex-launch-windows]]
