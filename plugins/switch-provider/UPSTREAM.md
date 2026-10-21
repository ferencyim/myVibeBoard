# Upstream

- Source: https://github.com/anh-chu/paseo-plugin-switch-provider
- Commit: e35f1d4abcc988f0c80c8eeab66bf98372754958
- Published as: npm paseo-plugin-switch-provider@0.2.1 (Paseo registry id anh-chu/switch-provider)
- License: MIT (see LICENSE in this directory; no NOTICE file upstream)
- Imported: 2026-10-19
- Role in myVibeBoard: Switch provider plugin: continue a session on another provider with history.

## Local changes versus upstream

- Removed `.git`/`.github`. Excluded from root tsconfig/oxlint/oxfmt/knip.

- Settings page (WP-99): compaction limits (`keepTurns`, `targetPercent`, `defaultWindowTokens`, block/list caps, transcript page size) and the three prompt texts (summary header, "Understood..." reply, transcript hand-over prompt) are plugin settings (`shared/settings.ts`, `client/settings.tsx`), defaults equal the former constants. The plugin does not depend on vibe.db (it stays installable on its own), so its texts are not in the central prompt registry; the Agent behaviour page links to this settings page instead.
- `npm test` runs `npm run check`, which now writes its bundle under `node_modules/.cache` so it also works on Windows.
