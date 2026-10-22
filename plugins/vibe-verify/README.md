# vibe-verify

myVibeBoard plugin. Supported Paseo versions: see `requirements.paseo` in `paseo-plugin.json`.

```bash
npm install   # first time: creates package-lock.json (commit it)
npm run typecheck && npm test
```

## Evidence collectors (WP-22)

`server/collectors/{web,backend}` implement `EvidenceCollector` (see `server/vibe/contract/collector.ts`).
Both read `<worktree>/.vibe/verify.json` (schema: `VerifyConfigSchema` in `server/collectors/common.ts`).
The browser (`BrowserDriver`), processes (`Runner`), dev servers (`ServerLauncher`) and HTTP (`HttpClient`)
are injectable; unit tests use fakes. Real run: `npx playwright install chromium`, then
`VIBE_E2E_WEB=1 npm test`.

### Performance before/after (`backend.perf`, WP-47)

`.vibe/verify.json` may carry `backend.perf`: `{ label, command, args, cwd?, runs (3), thresholdMs?, beforeMs?,
copyToBaseline? }`. The backend collector runs the command `runs` times in the fixed worktree and, when a
baseline worktree exists, in the pre-change commit (files in `copyToBaseline`, e.g. a new bench script, are
copied in for the run and unlinked afterwards), compares the medians and writes `perf-compare.json`.
Judgement: fail if the command fails or `after > thresholdMs`; doubt if under 10% faster or no before timing
(`beforeMs` is accepted as a recorded fallback); else pass. The pipeline creates the baseline worktree for web
projects and whenever the worker's `.vibe/verify.json` has `backend.perf`, injects it, and keeps the worker's
`backend.perf` when the verifier's own config lacks it. vibe-maintain's `perf-slow` rule tells its worker to
write this block.

## iOS and desktop collectors (WP-46)

- `server/collectors/ios`: `createIosCollector` drives `xcrun simctl` (boot, install, launch, screenshot,
  recordVideo, crash reports) on a remote Mac through the system `ssh`/`scp` (`RemoteMacExecutor`, BatchMode,
  no passwords). The host is only an ssh alias from the user's `~/.ssh/config` (`<MAC_HOST>`): plugin option
  `host`, env `VIBE_MAC_HOST`, or `ios.host` in verify.json. `detect()` runs `uname && xcodebuild -version`
  and reports why the Mac is unusable. Scratch files stay in `/tmp/vibe-verify/<run>` on the Mac (never deleted
  recursively).
  **Xcode not selected by `xcode-select`** (Command Line Tools active, or Xcode on an external disk): set
  `developerDir` (plugin option, env `VIBE_MAC_DEVELOPER_DIR`, or `ios.developerDir` in verify.json, an absolute
  path such as `<XCODE_APP>/Contents/Developer`). Every remote command is then prefixed with
  `export DEVELOPER_DIR=...;`, and `detect()` reports a missing directory as "is the external disk mounted?".
  `dispose()` stops only what the run started (recorder, app, and the simulator only if the run booted it).
  Verified on a real Mac (WP-73, Xcode 26.6, iOS 18.6 simulator): boot, `app.appPath` sync + install,
  `app.build` remote `xcodebuild` + install, launch, screenshots, recordVideo (mp4), crash-report scan, GIF,
  pre-running simulator left running. Sample: `docs/vibe/screens/ios-evidence-sample.png`.
  Real run: `VIBE_E2E_IOS=1 VIBE_MAC_HOST=<alias> [VIBE_MAC_DEVELOPER_DIR=...] [VIBE_E2E_IOS_DEVICE="iPhone 16"]
  [VIBE_E2E_IOS_APP=<local .app>] [VIBE_E2E_IOS_BUILD_CWD=<project dir on the Mac>] npm test`. A test app is a
  single-file SwiftUI project (`EvidenceApp.swift` + a minimal `project.pbxproj`, bundle id
  `com.example.vibeverify.evidence`, `GENERATE_INFOPLIST_FILE=YES`) built with
  `xcodebuild -scheme EvidenceApp -sdk iphonesimulator -derivedDataPath build CODE_SIGNING_ALLOWED=NO build`.
  On Windows Git Bash set the env vars from PowerShell (MSYS rewrites `/Volumes/...` values).
- `server/collectors/desktop`: `createDesktopCollector` starts the built app, waits for its window, takes
  window screenshots (Windows: PowerShell + user32 PrintWindow; macOS: full-screen `screencapture`, degraded),
  builds a GIF from the step frames, keeps stdout/stderr, and stops only the process it started. For
  Electron apps `automation: "electron"` uses Playwright `_electron` for click/fill/press steps. Apps whose
  launcher exits and hands over to another process (e.g. Windows 11 Notepad) need `windowTitle`.
  Real run on this machine: `VIBE_E2E_DESKTOP=1 npm test`.

## Verification pipeline (WP-20)

A `card.moved to=verifying` event starts `server/pipeline`:

- The verifier agent runs on the card's verification model (WP-108: `resolveModel("verifier")`, card -> project ->
  global default). Only when none is set anywhere does the old pick run (a different provider than the worker when
  possible; `pickVerifier`), and the notes say so.
- `needs_evidence` cards (mode `evidence`): the independent, read-only verifier agent first replies with a verify config (`VerifyConfigSchema`), the
  collectors of the project type run (`server/registry.ts`: web, backend, android, ios, desktop; Android leases go
  through the `device_lease` table), tests/lint run, then the verifier judges each check from the evidence.
  The verifier never writes: it answers in its reply. Read-only is enforced by the permission policy
  (`server/verifier/policy.ts`), a `git status` + HEAD snapshot around each round (a changed tree voids the
  evidence, conclusion `doubt`), and the board MCP for `VIBE_ROLE=verifier` (read + comment).
- other cards (mode `tests_only`): the project's tests and lint, then the verifier judges each check from their logs.
- Conclusion = fail > doubt > pass. `fail` sends the card back to `in_progress` (actor `verifier`) and the failing
  checks go to the worker session as its next prompt; `doubt`/`pass` leave the card in `verifying` for the user.

Plugin RPCs (`shared/rpc.ts`): `vibe.verify.get`, `vibe.verify.list`, `vibe.verify.evidence`,
`vibe.verify.approve` (-> done), `vibe.verify.reject` (comment -> in_progress + worker prompt),
`vibe.verify.rerun`.

Evidence lives in `$VIBE_HOME/verify/<card key>/<verification id>/`. Baseline worktrees for web before/after
go under `$VIBE_WORKTREE_ROOT` (default `$VIBE_HOME/worktrees`; on Windows point it at D:).

## Model review (WP-80)

A card with `reviewerPresetId` gets an extra read-only reviewer agent (that preset's provider/model, same
permission hook, tree-snapshot guard and `VIBE_ROLE=verifier` MCP as the verifier) after the checks of every
verification. It receives the diff (merge-base of HEAD with the preset's base branch / main / master, working tree
included), the card text and the latest plan, and answers `{verdict, summary, issues[{severity, file?, line?, text}]}`.
Sequential (after the checks) so the tree is stable and the findings of checks and review go to the worker in one return.

- Items: `verification_item.kind = review`; one per issue with method `review:<severity>`, or one `review` row (pass).
  `severe` -> `fail` (card verifying -> in_progress, actor verifier, reason "review found severe issues", the
  reject event carries `reviewReturn: true`; the worker gets the findings as prompt); `major`/`minor` -> `doubt`.
- Events: `review.started`, `review.finished` (verdict `pass|issues|severe`).
- Loop guard: after `VIBE_REVIEW_MAX_RETURNS` (default 3) consecutive review-caused returns, severe issues are only
  `doubt` and a `master.alert` of kind `review_loop` is published (vibe-master notify pushes it).
- A reviewer that cannot start, answers garbage or modifies the tree gives a `doubt` row, never a return.
