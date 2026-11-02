# daily-install-restart

> myVibeBoard daily install (D:\Programs\myVibeBoard): when updated plugins carry vibe.db migrations, restart the whole daemon instead of reloading plugins one by one（类型 project，最后修改 2026-10-27T00:56:54.204Z）

On 2026-10-26, copying WP-130 plugins into D:\Programs\myVibeBoard and running `paseo.ps1 plugin reload` one by one left vibe-board, vibe-context, vibe-stats and vibe-verify stuck ~11 min then "did not initialize"; the migration itself (18→20) takes ~0.2 s on a copy. A full daemon restart (stop-daemon.ps1, then Start-ScheduledTask 'myVibeBoard Daemon') brought all 8 plugins up in ~4 min with the DB migrated.

**Why:** suspected old/new plugin processes holding vibe.db at the same time during staggered reloads (not proven).

**How to apply:** for plugin updates that add migrations, back up vibe.db with `VACUUM INTO` (robocopy can fail with exit 9 on the live DB), check no agent is running, then restart the daemon as a whole. Plain plugin reload is fine only when no migration changes. See [[upstream-first-qoder-cli]].
