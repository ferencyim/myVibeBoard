# real-ui-acceptance

> myVibeBoard: never report a WP as done from unit tests alone — verify every user requirement in the installed daily desktop app via CDP before closing（类型 feedback，最后修改 2026-10-29T04:53:09.211Z）

User (2026-10-29): "我前面提的7点问题和要求，你要完整确认全部做到位了才可以验收啊，怎么总是没做完，没实现目标，就结束了？" and "不管有没有 agent 对话，UI 上应该始终是完整的".

**Why:** Round 9 shipped WP-132..135 green on tests, but in the real app the task still showed only #1, plugin settings pages were hidden in a "…" menu, the project agent failed to open, and one install silently aborted (check-plugins refused a manifest range; I only grepped the output and ignored exit code 1).

**How to apply:**

- After every daily install, check the installer exit code and that changed files actually landed under D:\Programs\myVibeBoard.
- Drive the installed desktop via CDP: relaunch `D:\Programs\myVibeBoard\app\Paseo.exe --remote-debugging-port=9340 (9339 was held by a dead process on 2026-10-30; scratchpad cdp scripts read CDP_PORT, default 9340)` (env PASEO_HOME/VIBE_HOME/PASEO_ELECTRON_USER_DATA_DIR as in launch-desktop.ps1), then Playwright `chromium.connectOverCDP` from the repo's node_modules for screenshots, text and clicks. PrintWindow/CopyFromScreen don't work for this Electron window.
- Walk every numbered user requirement in the real UI and list pass/fail before saying done. UI must be complete even when backend state is missing (placeholder tabs, visible settings entries).
- See [[daily-install-restart]], [[upstream-first-qoder-cli]].
