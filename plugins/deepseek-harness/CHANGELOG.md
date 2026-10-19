# Changelog

## 0.1.0-beta.13 — 2026-10-18

- **Requires Paseo 0.11.0 or later.** On Paseo 0.8 to 0.10, stay on beta.12.
- Launch DSH the way Paseo launches its own providers. The plugin registers
  the default command `dsh --profile acp`; the daemon finds it on PATH or
  applies `agents.providers.deepseek-harness.command` and passes the resolved
  executable and environment. Processes start with the SDK's `spawnProcess`
  and stop with `terminateProcess`, so a `dsh.cmd` launcher works on Windows
  and the whole process tree stops there. This replaces the hand-built Windows
  shell handling proposed in #27.
- **Breaking:** `DSH_PASEO_COMMAND` and `DSH_PASEO_PROFILE` are no longer
  read. Put the executable and profile in
  `agents.providers.deepseek-harness.command`.
- Add provider `status()`: an unreadable or too-old `dsh` now shows the
  provider as unavailable, and `paseo provider diagnostic deepseek-harness`
  gives the reason, before an agent is started.
- Add a DeepSeek usage source. The Usage panel shows the API balance from
  `https://api.deepseek.com/user/balance`, as text in the account's currency.
  The key is looked up in DSH's order (environment, `$DSH_HOME/.credentials.yaml`,
  `$DSH_HOME/.env`) on each fetch and is not stored. Adds the runtime
  dependencies `yaml` 2.9.1 and `zod` 4.4.3.
- Document that the displayed timeline is empty after an agent reload or
  daemon restart: Paseo rebuilds it from the provider's replay, and DSH does
  not replay.
- SDK development dependencies move from 0.9.2 to 0.11.4.
- Tests start the fake DSH peer through Node, so they no longer fail with
  `spawn EFTYPE` on Windows. A new Windows CI job loads the plugin in a Paseo
  0.11.4 daemon with the npm `dsh.cmd` launcher.

## 0.1.0-beta.12 — 2026-10-18

- Ship `npm-shrinkwrap.json` in the npm package. Paseo's registry requires a
  published lock for runtime dependencies, so the registry entry
  `geoqiao/deepseek-harness` stayed pinned to beta.10, which has no
  `icon.svg`, and `paseo plugin add geoqiao/deepseek-harness` still failed
  with `Invalid plugin provider icon "icon.svg"` (#28). `prepack` now writes
  the shrinkwrap from the production entries of `package-lock.json`; it locks
  `@agentclientprotocol/sdk` 1.4.0 with its resolved URL and integrity, and
  `postpack` removes it from the source tree.
- Runtime code is unchanged from beta.11.

## 0.1.0-beta.11 — 2026-10-11

- Fix npm installation on Paseo 0.11. The npm package omitted `icon.svg`, the
  icon the provider registers, and Paseo 0.11.2 rejects the plugin with
  `Invalid plugin provider icon "icon.svg"`. This affected the npm package and
  the registry entry `geoqiao/deepseek-harness`, which installs it; the Git
  source was not affected. The package now ships the icon, and a test checks
  that the registered icon is in the package `files` list.
- Ship `OVERVIEW.md` in the package for the Paseo plugin registry listing.
- Runtime code is unchanged from beta.10.

## 0.1.0-beta.10 — 2026-09-29

- Keep DSH reasoning out of assistant replies. dsh-acp sends thought and answer
  chunks with the same ACP `messageId`, which ACP defines as one message, so
  Paseo showed the reasoning again in the answer. The compatibility bridge adds
  `:thought` only to nonempty thought IDs; answer IDs, text, and metadata are
  preserved. Reported upstream as deepseek-harness#8235; the shim will be
  removed once DSH sends distinct IDs.
- Add regression coverage for incremental and interleaved chunks, missing IDs,
  restored sessions, and history updates during load/resume. The nine new
  cases pass with SDK 0.9.2 and 0.10.1; see `docs/compatibility.md` for
  verification scope, including a live Paseo 0.10.1 turn.

## 0.1.0-beta.9 — 2026-09-29

- Add a Cafe cover screenshot and publishable npm package metadata. The Git
  source build remains in the repository manifest; npm packages omit that build
  because its `npm ci` and `npm run check` steps require the lockfile, tests and
  development dependencies, while Paseo installs runtime dependencies for npm
  sources.
- No runtime code changes.

## 0.1.0-beta.8 — 2026-09-29

- Replace the exact DSH version allowlist with a minimum, `0.1.5-rc.1`, so new
  DSH releases are no longer rejected before they are listed. Beta.7 refused the
  official `0.2.0-rc.1`. Versions are compared by Semantic Versioning
  precedence; only older releases and unparseable `--version` output fail.
- Verify the official `0.2.0-rc.1` closure through the production provider
  factory (capabilities, catalog, session list, clean close), matching a
  `0.1.7-rc.2` control. No prompt or paid inference was used.

## 0.1.0-beta.7 — 2026-09-28

- Replace the manifest range `>=0.8.0 <0.10.0` with the minimum-only
  `>=0.8.0`, so Paseo 0.10 daemons no longer reject the plugin. Paseo defines
  this range as admitting later prereleases and breaking releases; it is not a
  compatibility promise for untested versions.
- Move the exact Paseo SDK dev dependencies to `0.9.2`. Typecheck, lint and all
  32 tests also pass against `0.9.0-beta.1` and `0.10.0-beta.1`. A live load
  and one real turn passed on a 0.10.0-beta.1 daemon; no live 0.9.x daemon was tested.
- Add the published DSH `0.1.7-rc.2` CLI/ACP closure to the exact runtime
  guard after an isolated official-closure ACP probe and a production provider
  factory initialize/catalog/close check. The guard now checks membership in
  the version list, still without prefix, range or build-metadata matching.
- Retain the narrow `session/load` to `session/resume` bridge, typed tool
  output projection, opaque model IDs, ACP SDK `1.4.0`, and the existing
  no-auto-approval policy.
- Update the pinned installation reference and verification record. No model
  prompt or paid inference was used for the isolated DSH `0.1.7-rc.2` check.

## 0.1.0-beta.6 — 2026-09-24

- Add the published DSH `0.1.7-rc.1` CLI/ACP closure to the exact runtime
  guard after an isolated official-closure ACP probe and a production provider
  factory initialize/close check.
- Retain exact rejection of untested DSH versions, the narrow
  `session/load` to `session/resume` bridge, typed tool output projection,
  opaque model IDs, and the existing no-auto-approval policy.
- Update the pinned installation reference and verification record. No model
  prompt or paid inference was used for this upstream compatibility check.

## 0.1.0-beta.5 — 2026-09-23

- Add the published DSH `0.1.7-alpha.2` CLI/ACP closure to the exact runtime
  guard after an isolated official-closure ACP probe and a production provider
  factory initialize/close check.
- Retain the narrow `session/load` to `session/resume` bridge, typed tool
  output projection, opaque model IDs, and the existing no-auto-approval policy.
- Update the pinned installation reference and verification record. No model
  prompt or paid inference was used for this upstream compatibility check.

## 0.1.0-beta.4 — 2026-09-18

- Migrate the plugin's exact Paseo SDK dependencies to `0.9.0-beta.1` and
  bound the manifest to `>=0.8.0 <0.10.0`.
- Add the published DSH `0.1.6-alpha.2` CLI/ACP closure to the exact runtime
  gate after real ACP control-surface and provider checks; retain `0.1.5-rc.1`
  and `0.1.5-rc.2` support.
- Keep the narrow `session/load` to `session/resume` bridge and typed tool
  output projection because both tested DSH ACP closures advertise resume
  without legacy load support.
- Verify the latest alpha's real persistence reopen and typed read-tool output
  with bounded synthetic prompts, without changing approval policy.
- Update pinned installation instructions and verification records for Paseo 0.9
  beta and the alpha DSH release.

## 0.1.0-beta.3

- Move development and releases to `geoqiao/paseo-stuff`, subdirectory `plugins/deepseek-harness`, retaining the `deepseek-harness` plugin ID.
- Update repository metadata, installation instructions and the existing Cafe pointer. Runtime and dependencies are unchanged from beta.2.
- Old standalone release tags remain unchanged. Installed Git sources do not migrate automatically; preserve the existing runtime ID and enable/disable choice when switching sources.

## 0.1.0-beta.2

- Follow-up to a separate code review; see `docs/code-review.md`.
- Redact JSON-quoted and space-separated credential labels in startup diagnostics,
  including escaped quoted values. Tests use synthetic secrets only.
- Preserve the version-probe timeout cause instead of reporting its cleanup exit.
- Report missing executable/cwd ambiguity honestly, and identify stable/build
  versions without accepting an untested prefix.
- Remove a redundant connection reference and clarify environment propagation.
- Typecheck/lint and 32 tests pass, including 13 additional regression cases.

## 0.1.0-beta.1

Initial beta release.

- Registers DeepSeek Harness as a Paseo provider with the public ACP shim.
- Launches the official DSH ACP profile without a shell.
- Bridges DSH session/resume to the shim private session/load expectation
  only when the initialized peer advertises resume but not load.
- Preserves DSH model, reasoning, MCP, image, tool, usage, permission and
  cancellation behavior without local session or credential storage.
- Supports and tests DSH 0.1.5-rc.1 and 0.1.5-rc.2.
- Closes connector resources during version probing, initialization and active
  prompts without allowing a post-close ACP child spawn.
- Owns pending connects and already-closing connections in async entry cleanup,
  fixing the installed-host IPC shutdown acknowledgement race.
- Records separate live public-SDK verification for both CLI versions; see the
  README for the exact scope and desktop/mobile limitations.
- Passes 19 automated tests and a repeated installed macOS Paseo 0.8.0 cycle:
  clean stop/start, complete tool output, restored context and retained history.
