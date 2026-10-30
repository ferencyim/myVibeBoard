# vibe-git

在 workspace 和 Explorer 的「Git/构建」面板查看当前仓库、同仓库 worktree、构建和发布状态。面板可手动刷新，挂载期间每 30 秒刷新；手机通过 daemon RPC 获取相同数据。宿主可能保留隐藏面板，当前插件 API 不提供可见性状态，因此隐藏时也可能刷新。

Git 信息由 daemon 在 workspace 目录只读查询。构建和发布数据取自 daemon 本机的 `http://127.0.0.1:43173` ci-dashboard，使用仓库主检出路径匹配；可通过 daemon 环境变量 `VIBE_CI_DASHBOARD_URL` 覆盖地址。客户端不接收 token 或完整日志。

其他 worktree 的改动数由后台串行扫描，按仓库缓存五分钟；扫描期间显示上次结果或未知。状态结果缓存十秒，手动刷新绕过此缓存。插件停止时终止正在运行的 Git 进程树。

三个区块独立降级：非 Git 目录显示「不是 Git 仓库」；CI 服务不可达或项目未配置时分别提示，发布服务返回的错误及旧数据状态也会显示。服务不可用不会阻止查看其他区块。

验证：在插件目录运行 `npm run typecheck` 和 `npm test`。
