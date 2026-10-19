# Upstream

- Source: https://github.com/anh-chu/paseo-plugin-tasks
- Commit: 147b5ea33d2dfed0c53beae4fdaae79f36d817fa
- Published as: npm paseo-plugin-tasks@0.1.1 (Paseo registry id anh-chu/tasks)
- License: Apache-2.0 (see LICENSE in this directory; no NOTICE file upstream)
- Imported: 2026-10-19
- Role in myVibeBoard: Tasks plugin; base for the kanban board (P1 will modify it).

## Local changes versus upstream

- Added `@getpaseo/client@0.11.2` to devDependencies (upstream typecheck fails without it) and updated package-lock.json.
- Added a local `vitest.config.ts` so tests do not pick up the repo-root vitest config.
- Removed `.git`/`.github`. Excluded from root tsconfig/oxlint/oxfmt/knip (standalone project with its own node_modules).
