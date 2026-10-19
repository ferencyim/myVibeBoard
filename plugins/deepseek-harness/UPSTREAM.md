# Upstream

- Source: https://github.com/geoqiao/paseo-stuff (plugins/deepseek-harness)
- Commit: b1d9f4b1202b2e04b16b30acb69e15aaf446118c
- Published as: npm paseo-deepseek-harness@0.1.0-beta.13 (Paseo registry id geoqiao/deepseek-harness, reviewed commit 33f4fd9e)
- License: MIT (see LICENSE in this directory; no NOTICE file upstream)
- Imported: 2026-10-19
- Role in myVibeBoard: DeepSeek provider via dsh --profile acp (needs dsh >= 0.1.5-rc.1, Node >= 22.19).

## Local changes versus upstream

- Added local `vitest.config.ts` and `.oxlintrc.json` so repo-root configs are not picked up.
- Removed `.github`. Excluded from root tsconfig/oxlint/oxfmt/knip.
- Note: one provider test ("cleans up on EOF...") times out at the 5s default on a slow Windows machine; passes with a longer timeout.
