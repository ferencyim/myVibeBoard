# Verification and limits

## Beta.13 — Paseo 0.11 launch, status and usage (2026-10-18)

- `npm run check` on Node 24.18.0 with SDK **0.11.4**: typecheck, lint with
  zero warnings/errors and **82 tests / 4 files**. The fake peer now receives
  the daemon-style `launch`; new tests cover the registered command, `status()`
  for a good, too-old and missing executable, session variables over the launch
  environment, and the usage source.
- **Live, isolated Paseo 0.12.0-beta.2 daemon on macOS** (temporary home, port
  6799), the worktree installed as a directory, global DSH **0.2.0-rc.2**:
  - `paseo provider ls` showed the provider `available` with three models. A
    real turn read `secret.txt` with a shell tool and answered the codeword;
    `ps` showed `node /opt/homebrew/bin/dsh --profile acp`, the path the daemon
    resolved.
  - `agents.providers.deepseek-harness.command` pointing at a wrapper script in
    a directory with a space: the daemon's availability check, the plugin's
    version probe (`--profile acp --version`) and the ACP process all ran
    through the wrapper, and a real turn completed.
  - The same override pointing at a script that prints `0.1.4`: the provider
    became `unavailable`, and `paseo provider diagnostic deepseek-harness`
    printed the unsupported-version message.
  - `paseo delete` ended both DSH processes. `paseo stop` during a foreground
    `sleep 48` tool call ended the shell and the sleep within three seconds.
    The beta.12 test's surviving `sleep 45` was a background job the tool
    started; DSH lets background jobs outlive the turn.
  - The Usage panel in the hosted web client listed **DeepSeek** with
    `Balance ¥13.26` from the real balance endpoint, using the key in
    `~/.dsh/.credentials.yaml`. `paseo usage --agent` returned nothing for a
    DeepSeek Harness agent: in Paseo 0.12.0-beta.3 only built-in provider
    sessions implement `usageSession()`.
- **DSH 0.2.1-rc.2** (npm `next`), installed under `/tmp` with its own
  `DSH_HOME` set through `agents.providers.deepseek-harness.env`: status
  `Ready` with three models, a real tool turn, and after `paseo agent reload`
  the agent recalled a number from the first turn.
- **Displayed history:** after `paseo agent reload` the timeline held only the
  new turn. Paseo's `hydrateTimelineFromProvider` deletes the stored timeline
  and records the provider's replay; dsh-acp documents `session/resume` as
  restoring the log "without replaying old updates".
- **Packed npm artifact:** `npm pack` gave 13 files and an
  `npm-shrinkwrap.json` that locks `@agentclientprotocol/sdk` 1.4.0, `yaml`
  2.9.1 and `zod` 4.4.3 with integrity hashes. The extracted package, with only
  its runtime dependencies installed, loaded on the 0.12.0-beta.2 daemon, ran a
  real tool turn and returned the balance.
- **Live, isolated Paseo 0.11.4 daemon on macOS** (`@getpaseo/cli@0.11.4` from
  npm, temporary home): the packed package reached `running`, the provider was
  `Ready` with three models, a real tool turn answered the codeword, and after
  `paseo agent reload` the agent recalled a number from the first turn.
  `paseo delete` left no DSH process. The 0.11.4 CLI has no `usage` command;
  the usage source registered without errors in the daemon log, and the balance
  itself was checked only on 0.12.0-beta.2.
- **Without credentials** (empty `DSH_HOME`, no `DEEPSEEK_API_KEY`): status
  `Ready` with one model. The Windows CI job relies on this.
- **Windows CI job** (`deepseek-harness / Windows daemon` in `ci.yml`): runs
  `npm run check`, installs `@getpaseo/cli@0.11.4` and the npm `dsh`
  (`dsh.cmd`), loads the plugin directory in a daemon and requires `Ready` and
  a model list. Its daemon script passed on macOS with the 0.11.4 CLI and DSH
  0.2.1-rc.2. The fake peer now runs as `node fake-dsh.mjs`, which avoids the
  `spawn EFTYPE` failures reported in #27.
- **Not verified:** Windows (the CI job has not run yet), the desktop app and
  native mobile.

## Beta.12 — post-release install check (2026-10-18)

- `paseo plugin add npm:paseo-deepseek-harness@0.1.0-beta.12` on an isolated
  Paseo 0.12.0-beta.2 daemon reached `running`. The provider was available
  with three models; a real turn read a file through a tool and kept the
  reasoning separate from the answer; context survived `paseo agent reload`
  and a daemon restart, and `paseo delete` ended the DSH process.

## Beta.12 — npm shrinkwrap (2026-10-18)

- Registry review getpaseo/plugins#308 held the beta.11 bump because the npm
  package ships no lock for its runtime dependency. The registry entry stayed
  on beta.10.
- On an isolated Paseo 0.12.0-beta.2 daemon (temporary home, relay disabled,
  no client connected), `paseo plugin add geoqiao/deepseek-harness` failed
  with `Invalid plugin provider icon "icon.svg": file does not exist or is not a
  regular file`, as reported in #28. `paseo plugin add
  npm:paseo-deepseek-harness@0.1.0-beta.11` on the same daemon reached
  `running`.
- `npm pack` produces 12 files including `npm-shrinkwrap.json`, which
  contains only the root entry and `@agentclientprotocol/sdk` 1.4.0 with
  `resolved` and `integrity`. In the extracted package,
  `npm ci --omit=dev --ignore-scripts --legacy-peer-deps` installed exactly
  that one package, so the shrinkwrap matches the packed `package.json`. After
  packing, the source tree has no shrinkwrap or pack state left.
- `npm run check` on Node 24.18.0 with SDK 0.9.2: typecheck, lint with zero
  warnings/errors and **75 tests / 3 files**.
- Not verified before release: installing beta.12 through Paseo. Paseo accepts
  only published npm packages, not a local tarball.

## Beta.11 — npm package icon (2026-10-11)

- The install commands were run on an isolated Paseo 0.11.2 daemon (temporary
  home, relay disabled, no client connected). Both npm routes for beta.10,
  `paseo plugin add geoqiao/deepseek-harness` and
  `paseo plugin add paseo-deepseek-harness`, failed with
  `Invalid plugin provider icon "icon.svg": file does not exist or is not a
  regular file`. The beta.10 tarball contains no `icon.svg`; the provider
  registers that icon.
- On the same daemon the `git:` command with tag
  `deepseek-harness-v0.1.0-beta.10` ran the preparation commands and reached
  `running`. The old source without `git:` is rejected as a registry ID.
- Beta.11 adds `icon.svg` to the package `files` list and a test that the
  registered icon is listed there and exists. `npm run check` on Node 24.18.0
  with SDK 0.9.2: typecheck, lint with zero warnings/errors and
  **75 tests / 3 files**.
- `npm pack` produces 11 files including `icon.svg` and `OVERVIEW.md`. The
  extracted package, with its production dependency installed, was added to
  that daemon as a directory: it reached `running`, logged `Plugin ready` and
  `paseo provider ls` listed DeepSeek Harness.
- Not verified before release: installing the published beta.11 from npm or
  through the registry, and a real turn on 0.11.2.

## Paseo 0.11.2 check (2026-10-11)

- No runtime change; the released beta.10 code is unchanged. This check
  accompanies the new `OVERVIEW.md`, its entry in the npm `files` list and the
  install commands for Paseo 0.11.
- `npm run check` on Node 24.18.0 with SDK 0.9.2: typecheck, lint with zero
  warnings/errors and **74 tests / 3 files**. An isolated copy with SDK 0.11.2
  (client, plugin, protocol) installed without saving gives the same result.
- `npm pack --dry-run` lists `OVERVIEW.md` among the 10 packaged files.
- The existing local directory installation reports `running` on a Paseo
  0.11.2 daemon, and its log shows `Plugin ready` with no error output.
- Paseo's registry lists the plugin as `geoqiao/deepseek-harness`, pinned to
  npm `paseo-deepseek-harness@0.1.0-beta.10`.
- Not verified: a real turn, resume or tool call on 0.11.2 for this check. The
  install commands were run afterwards; see the beta.11 section above.

## Beta.8 — minimum-only DSH version check (2026-09-29)

- Beta.7 accepted only six exact DSH releases, so the official `0.2.0-rc.1`
  (npm `next`, published 2026-09-28) was rejected even though nothing in its
  ACP surface changed. The exact list is replaced by a minimum, `0.1.5-rc.1`
  (the oldest tested release), compared with Semantic Versioning 2.0 precedence;
  build metadata is ignored. Only older releases and unparseable `--version`
  output are rejected. No DSH release is known to be incompatible, so none is
  excluded. ACP behaviour was already chosen from the advertised capabilities.
- `npm run check` on Node 24.18.0 with SDK 0.9.2: typecheck, lint with zero
  warnings/errors and **65 tests / 2 files**. New cases accept `0.1.5-rc.3`,
  `0.1.6-alpha.1`, `0.1.7-rc.3`, `0.2.0-rc.1`, `1.0.0-alpha.1` and build
  metadata, reject `0.1.5-rc.0`, `0.1.5-alpha.2`, `0.1.4` and malformed
  versions, and connect the provider to fake `0.1.7-rc.3`/`0.2.0-rc.1` CLIs.
- Official `@deepseek-ai/dsh@0.2.0-rc.1` and a `0.1.7-rc.2` control were
  installed with `--ignore-scripts` in separate prefixes and isolated `HOME`
  directories (no credentials). Both use ACP SDK `1.4.0`. The production
  `createDeepSeekHarnessProvider` returned identical results for both:
  capabilities `prompt.message`, `session.configure`, `session.list`,
  `session.persistence` and `permission`; default model `deepseek-v4-flash`
  among three `deepseek-official` models; thinking `off/low/high/max`; one
  listed session (the empty one catalog discovery creates); clean close and
  dispose with no leftover DSH processes. No prompt or paid inference ran.
- Not verified for 0.2.0-rc.1: real turns, tool calls, resume after restart and
  the signed-in model catalog. The local daemon (Paseo 0.10.1) still uses the
  global DSH 0.1.6-alpha.2 and was not reloaded for this change.

## Beta.7 — Paseo 0.10.0-beta.1 and DSH 0.1.7-rc.2 (2026-09-28)

2026-09-28. Beta.7 pins the public Paseo SDK to **0.9.2**; the same automated
suite also passes against **0.9.0-beta.1** and **0.10.0-beta.1**. The earlier
0.8.0 daemon evidence remains historical evidence. The manifest's
minimum-only `>=0.8.0` range follows Paseo's requirements contract: it admits
0.8.0 and all later releases, including prereleases and future breaking
releases, and is not a compatibility promise for untested versions. An upper
bound is added only if a later release proves incompatible. Beta.7 was loaded on
the local 0.10.0-beta.1 daemon and completed a real turn (see below); no live
0.9.x daemon was tested.

## Upstream evidence

- Paseo `v0.9.2` is commit `c67b7158b441bb09026b38d86ae335cc4b49190a`
  (2026-09-24); `v0.10.0-beta.1` is prerelease commit
  `52d345db7f271251787c1099a2fe48fde515f012` (2026-09-27). The published
  `@getpaseo/plugin` dist, including `server/acp`, `server/provider` and
  `runAcpProvider`, is byte-identical across 0.9.0-beta.1, 0.9.2 and
  0.10.0-beta.1 and still depends on `@agentclientprotocol/sdk` `^1.4.0`. The
  relevant host changes are lifecycle fixes: a provider connection stays
  registered until its close reports, input to a closing connection is
  rejected, a failed plugin provider request no longer crashes the daemon
  (Paseo #5298, #5231), and slash commands for custom ACP providers were fixed
  (#5411). None changes the provider contract. Paseo's plugin reference at
  v0.10.0-beta.1 defines `>=0.8.0` as including prereleases and future
  breaking releases, and recommends an upper bound only for a known
  incompatibility.
- On 2026-09-28 npm reports both `latest` and `next` as DSH `0.1.7-rc.2`
  (published 2026-09-24) and `alpha` as `0.1.7-alpha.2`. The previous tested alpha tarball is
  [`@deepseek-ai/dsh@0.1.6-alpha.2`](https://www.npmjs.com/package/%40deepseek-ai/dsh/v/0.1.6-alpha.2) with integrity
  `sha512-PHR/3ZHpJNWXlDQ3U9weFb7calWbSMJd2GD3z2iPJ8zAKL7ipuzyPy5xGbaXf2OA8hc0SAGJeoUW7nfatCNOYw==`.
- The official DSH tag `dsh-v0.1.6-alpha.2` resolves to commit
  [`ddefc45fbc7f8e46dd73185e68295696d1297887`](https://github.com/deepseek-ai/deepseek-harness/commit/ddefc45fbc7f8e46dd73185e68295696d1297887). Its published CLI closure
  resolves DSH, `dsh-acp-app`, and `dsh-acp` to `0.1.6-alpha.2`, with
  `@agentclientprotocol/sdk` `1.4.0` and matching alpha.2 agent, session, LLM,
  MCP, persistence, token-meter, and approval packages.
- The [official ACP package contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.2/packages/acp/acp/README.md) for both tested closures advertises
  `session/list`, `session/resume`, and `session/close`, omits legacy
  `session/load`, and documents that resume does not replay history. The
  published ACP mappings for rc.2 and alpha.2 retain message IDs on assistant
  and reasoning chunks and typed content blocks on tool results.
- The official tag `dsh-v0.1.7-alpha.2` resolves to commit
  `00102833dfaee1da9f48a3a8eae9d34005a75218`. Its published CLI, ACP app and
  ACP packages resolve to the same alpha.2 line, and the published
  `@deepseek-ai/dsh@0.1.7-alpha.2` tarball has integrity
  `sha512-uXuWobwmpNzqFOTFP61kgf0aH8IzU9LWPF9QWCUfv5DOtgtlm+6+zHvQMboEe0bCaitul61ySvUqd4mMNRedzw==`.
- The official prerelease `dsh-v0.1.7-rc.1` (release ID `394685472`, published
  2026-09-23) resolves to commit
  [`46a7f68b0922371ce7144b668b90e377d8e799f4`](https://github.com/deepseek-ai/deepseek-harness/commit/46a7f68b0922371ce7144b668b90e377d8e799f4).
  The published `@deepseek-ai/dsh@0.1.7-rc.1` tarball has integrity
  `sha512-O1K076aCmqE+h4fB5J+mi3twNSAnh26OqHepaqvS5f1tccFnxhVyGpUmjcncVM5x1SX4niznmvsGrsRo9p733A==`;
  its ACP package has integrity
  `sha512-LPJvNjdoFBFb5QBOyq/UCdMYT/T51Yh7WkzbM7hdwqGQK8PVoaqNmRbvPCBQqUeO+HufhQ05vwwBAXoa0feDRA==`.
  The alpha.2-to-rc.1 source comparison changes the ACP package and bundle
  package versions; the ACP implementation files remain unchanged.
- The official prerelease `dsh-v0.1.7-rc.2` (release ID `395756051`, published
  2026-09-24) resolves to commit
  [`477b4f420553e8a52c2fbccc464d7561b239c443`](https://github.com/deepseek-ai/deepseek-harness/commit/477b4f420553e8a52c2fbccc464d7561b239c443).
  Locally recomputed tarball integrities match the registry:
  `@deepseek-ai/dsh@0.1.7-rc.2`
  `sha512-SQFhriLvza8GnFApnC5/32AgpcyKxrWnYXhvwDOLJdgWpkCX2EexyR9c8kCkMITJXnFLEN3Qb2CEh0W36vkLyw==`;
  `@deepseek-ai/dsh-acp@0.1.7-rc.2`
  `sha512-pYA/KH4ks/q/S82PEwdpGQ+Bdmyx8G4aspd2N0BVM9KAfupEszrgZyfNX7L0+hvy4sYTjP5LyUr6/2QmQVhXiw==`;
  `@deepseek-ai/dsh-acp-app@0.1.7-rc.2`
  `sha512-7Km0Fchvx/PoL3/By4M6ykKkrmmIgelXq/1l0624Ixt3JgTtFNSgko3dpL/32Hv/a5Fn/wEsuujBHzmcBBcZ7Q==`.
  The ACP package's `lib/` is byte-identical to rc.1 (only `README.i18n.yaml`
  and the version differ) and still uses `@agentclientprotocol/sdk` `1.4.0`.
  The CLI closure did change: it adds `@deepseek-ai/dsh-experimental-auto-review`
  (512 to 520 installed packages), reports skipped bundles on stderr at
  startup, changes code in runtime packages including `dsh-llm`,
  `dsh-agent-loop`, `dsh-session`, `dsh-user-approval` and tools, and makes
  `dsh-base` load `dsh-llm-deepseek-api-key` in the DeepSeek LLM slot (provider
  ID still `deepseek-official`) plus an `llm-deepseek-account` route whose
  catalog is empty when signed out.
- The 0.1.7 ACP implementation fixes tool-result projection to use the complete
  message content and identity. Its public initialize response retains ACP v1,
  `session/list`, `session/resume`, and `session/close`.

## Layers of evidence

The beta.1 baseline below had 19 automated cases. The separate
[beta.2 code review](code-review.md) passes typecheck/lint and **32 tests** after
diagnostic fixes and missing-coverage additions. Its new failures use synthetic
processes/strings; the real-inference evidence below was established in beta.1,
not silently reclassified as a fresh beta.2 API or native-client run.

| Layer | Evidence |
| --- | --- |
| Public SDK + fake ACP process | For beta.7 on Node 24.18.0, `npm run check` passed: typecheck, lint with zero warnings/errors, **32 tests / 2 files** against the pinned exact Paseo SDK `0.9.2`, and again with the SDK swapped to exact `0.9.0-beta.1` and `0.10.0-beta.1`. Node 22 was not available locally for beta.7; earlier releases passed on Node 22.23.2 and 24.21.0 against `0.9.0-beta.1`. Catalog/model/thinking IDs, config changes, multiple turns, persistence, complete output, MCP/image frames, allow/deny permissions, cancellation/errors/EOF, concurrent cwd/env isolation and closure during version probe/initialize/prompt are covered. |
| Real ACP control surface | The published rc.2 and alpha.2 CLIs each passed an initialize probe reporting ACP v1, `session/list`, `session/resume`, `session/close`, HTTP MCP, and no `loadSession`; each created and closed a temporary session. |
| Official runtime + public provider factory | On Node 22.23.2, isolated CLI `0.1.5-rc.2` with ACP `0.1.5-rc.2` and global CLI `0.1.6-alpha.2` with ACP `0.1.6-alpha.2` each passed catalog discovery, session open/configuration, one bounded synthetic no-tools prompt with the exact marker `SYNTHETIC_DSH_PASEO_CHECK`, usage/timeline events validated by `ProviderEventSchema`, and clean close. No permission event occurred. |
| New official alpha control surface + public provider factory | An isolated published CLI/ACP `0.1.7-alpha.2` closure reported the exact version and passed ACP initialize with `session/list`, `session/resume`, and `session/close`. The production `createDeepSeekHarnessProvider` completed initialize, capability mapping and clean connection/provider close through Paseo's public `runAcpProvider` shim. No model prompt, tool execution, approval, credential or paid inference was attempted. |
| New official rc control surface + public provider factory | An isolated published CLI/ACP `0.1.7-rc.1` closure reported the exact version, passed ACP initialize with `session/list`, `session/resume`, and `session/close`, and returned an empty result from `session/list`. After the exact guard was updated, the production `createDeepSeekHarnessProvider` completed initialize, capability mapping and clean connection/provider close through Paseo's public `runAcpProvider` shim. No model prompt, tool execution, approval, credential or paid inference was attempted. |
| New official rc.2 control surface + public provider factory | On Node 24.18.0, an isolated published CLI/ACP `0.1.7-rc.2` closure printed exactly `0.1.7-rc.2` for `dsh --version` and passed ACP initialize (protocol 1) with `session/list`, `session/resume`, `session/close` and no `loadSession`. `session/list` returned no sessions; `session/new` returned three `deepseek-official` models with reasoning effort off/low/high/max (default high); `session/close` returned `{}`; resume succeeded in the same and in a fresh process. The normalised output matched the same probe on rc.1. The unmodified beta.6 guard rejected rc.2 with its exact-version error. With rc.2 added to the guard, the production `createDeepSeekHarnessProvider` connected through Paseo's public `runAcpProvider` shim with capabilities `prompt.message`, `session.configure`, `session.list`, `session.persistence` and `permission`, returned an empty session list and a three-model catalog (default `deepseek-v4-flash`/high), and closed and disposed with no leftover processes; an rc.1 control run was identical. No model prompt, tool execution, approval, credential or paid inference was attempted. The signed-in account catalog, Node 22 and package install scripts were not exercised. |
| Latest alpha persistence and tool regression | On Node 24.21.0 with global `@deepseek-ai/dsh@0.1.6-alpha.2`, a temporary wrapper recorded **6/6** owned ACP profile children closed across provider disposal. A first no-tools prompt stored a unique marker; a second provider reopened the returned persistence, the wrapper observed `session/resume` and no `session/load`, and a second prompt recalled the marker without including it. A temporary `read-probe.txt` read-tool prompt returned the synthetic file marker through a typed `tool_call` raw-output detail; no permission event or approval response was involved. |
| Historical official runtime + production provider factory | CLI `0.1.5-rc.1` and `0.1.5-rc.2`, each with ACP package `0.1.5-rc.2` and ACP SDK `1.4.0`. Three real DeepSeek v4-flash/reasoning-off turns per version passed: memory, file write/read, complete >8,000-character tool-output tail, and native context after provider/child restart. All emitted events passed `ProviderEventSchema`; usage events arrived. |
| Local CLI upgrade | The authorized global installation moved from `@deepseek-ai/dsh` `0.1.5-rc.2` to `0.1.6-alpha.2`. `$HOME/.dsh/.credentials.yaml` remained owner-only (`0600`) with unchanged metadata; its contents were never read or logged. The `0.1.7-alpha.2`, `0.1.7-rc.1` and `0.1.7-rc.2` checks remained isolated and did not alter the global CLI. |
| Historical actual macOS Paseo daemon | Installed server entry and provider discovery succeeded. Two real turns retained context and a 101-line tool result. After disabling/enabling only this plugin, a third turn recalled the same marker and filename, and Paseo retained earlier displayed messages. No credential was passed in the Paseo agent configuration. |
| Real managed-child cleanup | An official DSH foreground shell tool launched a synthetic Node process that ignored SIGTERM. After closing the production provider, that owned child was gone. This is a targeted check, not a guarantee for arbitrary independently detached services. |
| Client UI | No custom client entry. Desktop UI matrix, native iOS/Android, vision requests and real MCP services are untested. Fake image/MCP frame tests are not live service or device tests. |

The 0.8.0 daemon and earlier 0.1.5-rc.1/rc.2 inference rows are retained from
previous beta evidence. The installed desktop daemon auto-updated to
0.10.0-beta.1 on 2026-09-28 and rejected beta.6 under its old `<0.10.0` range.
Beta.7 at PR head `1f44a52` was then reloaded into the existing enabled
`deepseek-harness` directory installation, without a daemon restart or
enable-state change, and reports running. One real deepseek-v4-flash,
thinking-off turn ran a single Bash tool call and returned its reply; the hosted
web client (app.paseo.sh, via relay) displayed both, and the test agent was
archived. The global `dsh` reports 0.1.6-alpha.2; 0.1.7-rc.2 was verified only
in the isolated checks above.

Real tests used only synthetic markers and temporary files. Personal conversations,
credentials and raw private fixtures are not included in this repository. API calls
are paid and are not part of CI.

## Shutdown regression and fix

The first actual disable/enable run exposed `ERR_IPC_CHANNEL_CLOSED` in Paseo
0.8's plugin-process shutdown. Its close handler removes a connection from the
host map before awaiting its asynchronous close; concurrent shutdown can then
disconnect IPC before the final close acknowledgement. Session restoration still
passed, but an exit error is not considered clean teardown.

The adapter now owns pending connects, scopes, resources and closing promises
through `dispose()` in its async entry cleanup. It marks all scopes closed before
any await and retains already-closing connections until their close settles.
Three added public-SDK/fake-peer regressions passed for pending version probing,
pending initialization and host-close acknowledgement ordering.

After loading the fix, the installed macOS daemon's disable/enable cycle was
repeated while DSH sessions were idle or closed. The new log interval contained
only stopping/stopped/loading/ready entries, with no IPC error or stderr. Another
real model turn restored the same marker and filename, and retained the earlier
Paseo history. All installed plugins' enable/status values were unchanged after
the cycle. The existing daemon was not restarted.

No host internals are imported or patched, and no global IPC/error handler is used
to hide the failure. Older log entries from the pre-fix runtime remain historical
evidence, not new failures. These targeted checks do not prove every possible
host shutdown or external detached-process scenario.

## Deliberate limitations and side effects

- DSH's ACP profile emits committed messages/thoughts and generic tool events,
  not raw token deltas, slash commands, steering, plans or terminal UI surfaces.
- Resume restores DSH context, not a replay of its transcript. Paseo owns its
  existing displayed history. Failed resume is never retried as a fresh session.
- Catalog discovery uses `session/new`; official DSH can retain those empty
  sessions. The plugin does not delete native records or read private transcripts.
- DSH profile settings stay authoritative. The generic ACP shim does not inject
  Paseo's extra system prompt. Custom profiles must still provide ACP over stdio.
- The CLI version guard is minimum-only (`0.1.5-rc.1`). Newer releases load
  without being tested; it does not pin the CLI's transitive packages or
  certify future dependency closures.
  DSH itself is a rapidly changing developer preview.
- Complete output is intentionally retained. Large payload transfer, storage,
  Raw and copying can be expensive. An optional renderer may bound display work;
  this adapter never drops the original body to make a preview faster.
- Plugins, official DSH and its tools run as trusted, unsandboxed code. Credentials
  stored with mode 0600 remain readable to tools running as the same OS user.

## Dependency review

On 2026-09-28 `npm audit --omit=dev` reported zero advisories for the
adapter's production dependencies. Against the isolated official CLI
lockfiles, `0.1.7-rc.1` and `0.1.7-rc.2` each report 8 moderate findings that
trace to one advisory: `@deepseek-ai/libreoffice-kit` `0.1.2` pins a nested
`fflate` `0.8.2`
([GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98),
an infinite loop on malformed ZIP64 archives), and the remaining findings are
the DSH office/web/SDK packages that depend on it. This is in DSH's own
dependency tree, is unchanged from rc.1, and the plugin neither installs nor
updates DSH. An earlier zero-advisory check covered the `0.1.5-rc.2` CLI tree
only. These are point-in-time package-advisory checks, not a security
certification. Official DSH's safety notice and the user's tool permission policy
still apply.
