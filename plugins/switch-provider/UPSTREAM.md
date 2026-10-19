# Upstream

- Source: https://github.com/anh-chu/paseo-plugin-switch-provider
- Commit: e35f1d4abcc988f0c80c8eeab66bf98372754958
- Published as: npm paseo-plugin-switch-provider@0.2.1 (Paseo registry id anh-chu/switch-provider)
- License: MIT (see LICENSE in this directory; no NOTICE file upstream)
- Imported: 2026-10-19
- Role in myVibeBoard: Switch provider plugin: continue a session on another provider with history.

## Local changes versus upstream

- Removed `.git`/`.github`. Excluded from root tsconfig/oxlint/oxfmt/knip.
- Note: `npm run check` writes to /tmp and fails on Windows; run the esbuild + node steps with another output path.
